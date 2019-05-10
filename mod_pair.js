const binance = require('./binance');
const buy = binance.buy;
const to = require('./mod_helpers').to;
const {print} = require('./mod_helpers');
const util = require('util');
const cancel = util.promisify(binance.cancel);
const openOrders = util.promisify(binance.openOrders);

// const EventEmitter = require('events');
//
// class MyEmitter extends EventEmitter {}
//
// const myEmitter = new MyEmitter();
//


/**
 * Pair object factory
 * @module charlesdarkwind/tradebot4
 * @return {object}
 */
class Pair {
    constructor(pair, S) {
        this.S = S;
        this.log_level = S.log_level;
        this.limiter = S.limiter;
        this.pair = pair;
        this.stop_time = 60 * 1000 * 60 * 5; // 5h
        this.is_buying = true;
        this.buy_placed = false;
        this.buy_price = undefined;
        this.buy_time = undefined;
        this.sl_pct = 18; // todo stop pair is sl
        this.sl_price = undefined;
        this.balance_available = undefined;
        this.balance_in_order = undefined;
        this.profit_pct = 0;
        this.profit = 0;
        this.sl_count = 0;
        this.buy_count = 0;
        this.error_count = 0;
        this.stopped = false;
        this.busy = false;
        this.buy_line = undefined;
        this.last_buy_line = undefined;
        this.isConcurrent = false;
        this.partial_fill_prices_buy = [];
        this.partial_fill_prices_sell = [];
        this.last_sell_placed_time = Date.now();
    }

    rnd(num) {
        return Math.round(num * this.round) / this.round;
    }

    decrementBuyCounts() {
        if (this.buy_count > 0)
            this.buy_count--;
    }

    decrementErrorCounts() {
        if (this.error_count > 0)
            this.error_count--;
    }

    stop() {
        this.stopped = true;
        this.stopped_until = Date.now() + this.stop_time;
    }

    restart() {
        this.stopped = false;
        delete this.stopped_until;
    }

    getTotalBalance() {
        return this.balance_available + this.balance_in_order;
    }

    /**
     * Shouldnt have more than 6 buys or errors per hour.
     * If the state is deemed incorrect, stop pair. If pair is already stopped,
     * check if it can be restarted.
     *
     * @return {boolean}
     */
    validate() {
        if (this.busy === true || this.cancelling_all_orders) return false;
        if (!this.stopped) {
            if (this.buy_count > 6 || this.error_count > 6) {

                if (this.log_level >= 2)
                    print(this.pair, `Stopping pair because: Too many buys? ${this.buy_count > 6}, Too many err? ${this.error_count > 6}`);

                this.stop();
                return false;
            }
        } else if (this.stopped && Date.now() > this.stopped_until) {
            this.restart();
        } else if (this.stopped && Date.now() < this.stopped_until) {
            return false;
        }
        return true;
    }

    /**
     * Calculate position size that can be bought considering what is already bought.
     * Round it with respect to LOT_SIZE.
     *
     * Set the float converted position size as attribute
     *
     * @return {string} position size string
     */
    setPositionSize() {
        const totalBTC = this.S.balance_btc_available + this.S.balance_btc_in_order;
        this.positionSizeInBTC = totalBTC / this.S.options.position_divider;
        this.positionSizeRawInCoin = (this.positionSizeInBTC - this.getTotalBalance() * this.buy_line) / this.buy_line;

        const boughtQuantity = this.getTotalBalance();
        let positionSize = binance.roundStep(this.positionSizeRawInCoin, this.stepSize);
        positionSize -= boughtQuantity;

        // Set the float
        this.position_size = parseFloat(positionSize);

        // Return the string
        return positionSize;
    }

    /**
     * Check if position_size >= minNotional, (qty looking to buy)
     * Check if bought quantity >= minNotional, (qty loking to sell)
     * Check if total quantity >= minNotional, (qty loking to sell (full position) after cancel of sell order)
     */
    setMinNotionalState() {
        this.position_size_is_over_minNotional = this.position_size >= this.minNotional; // !Needs fresh position_size!
        this.quantity_available_is_over_minNotional = this.balance_available >= this.minNotional;
        this.quantity_total_is_over_minNotional = this.getTotalBalance() >= this.minNotional;
    }

    /**
     * Query orders for a pair
     * @return {Promise<void>}
     */
    async order_infos(res) {
        const order = await openOrders.catch(err => console.log(err));
        print(this.pairs, `Err cancel resp`, err);
    }

    // NEW_LIMIT_SELL
    // FILLED_LIMIT_SELL
    // PARTIALLY_LIMIT_SEL


    async reveived_cancel_sell() {
        let err, res;

        [err, res] = await to(cancel(this.pair, this.tp_order_id));
        if (err) {
            this.error_count++;
            print(symbol, `Error when cancel sell order for ${name}.`, err);

            let err2, res2;  // REST: What happened?
            [err2, res2] = await to(openOrders(this.pair));
        }
    }

    /** Triggered by all sell event functions => means theres room for re-buying.
     *
     * Can it place a buy order?
     *  - Whats in queue? (Just DONT place new one of same side)
     *  - State is valid? (not stopped)
     *  - Concurent count? (less than options.concurent_count_max)
     */
    // async handle_sell() {
    //     const is_in_queue = this.limiter.getInfo(Pair, 'place_buy_order') == true;
    //     const isValid = this.validate();
    //     const is_concurents_ok = this.S.getConcurrent() < this.S.options.concurent_count_max;
    //
    //     if (isValid && !is_in_queue && is_concurents_ok)
    //         await this.limiter.limit('push', 'place_buy_order', this);
    //     else if (this.log_level >= 2)
    //         print(this.pair, `Cannot place buy. In queue? ${is_in_queue}, Valid? ${isValid}, Concurent? ${is_concurents_ok}`);
    // }

    /////////////////////////////////////////////////////////
    ///////////////////// CANCEL ALL ORDERS /////////////////
    /////////////////////////////////////////////////////////

    cancel_all_orders_error(e, side) { // both sell and buys
        this.error_count++;
        if (e.body && typeof e.body == 'string' && JSON.parse(e.body).code == -2011)
            print(this.pair, 'Unknown order -2011');
        else
            print(this.pair, `Cancell all ${side} orders error.`, e);
    }

    cancel_all_orders_success(res, side) { // both sell and buys
        if (this.log_level >= 2)
            print(this.pair, `Cancelling all ${side} orders success`);
        delete this.order_id;
    }

    async cancel_all_orders(orders, side) { // both sell and buys
        if (this.log_level >= 2)
            print(this.pair, `Cancelling all ${side} orders`);

        this.cancelling_all_orders = true;  // For WS response CANCEL_LIMIT_BUY spam

        await Promise.all(orders.map(order => {
            return new Promise((resolve, reject) => {
                binance.cancel(this.pair, order.orderId, (e, res, symbol) => {
                    if (e) this.cancel_all_orders_error(e);
                    else this.cancel_all_orders_success(res);
                    resolve();
                });
            });
        }));

        this.cancelling_all_orders = false;
        this.busy = false;
    };

    /////////////////////////////////////////////////////////
    ///////////////////// GET ORDERS ////////////////////////
    /////////////////////////////////////////////////////////

    async get_orders_error(e) { // both sell and buys
        this.error_count++;
        print(this.pair, 'Error when querying open orders', err);
    }

    async get_orders() { // both sell and buys
        await new Promise((resolve, reject) => {
            binance.openOrders(this.pair, (e, openOrders) => {
                if (e) this.get_orders_error(e);
                else resolve(openOrders);
            });
        });
    }

    async check_buy_orders() {
        const orders = await this.get_orders();
        const buyOrders = orders.filter(order => order.side == 'BUY' && order.symbol == this.pair);

        if (buyOrders.length >= 2) {
            this.error_count++;
            print(this.pair, 'CHECK: 2 buy orders or more, canceling all...');
            await this.cancel_all_orders(buyOrders, 'buy');

            // Order was there with another ID, cancel it
        } else if (buyOrders.length == 1) {
            this.error_count++;
            this.order_id = buyOrders[0].orderId;
            print(this.pair, 'CHECK: buy order found with different ID, canceling...');
            await this.cancel_buy();
        }
    }

    async check_sell_orders() {
        const orders = await this.get_orders();
        const sellOrders = orders.filter(order => order.side == 'SELL' && order.symbol == this.pair);

        if (sellOrders.length >= 2) {
            this.error_count++;
            print(this.pair, 'CHECK: 2 sell orders or more, canceling all...');
            await this.cancel_all_orders(sellOrders, 'sell');

            // Order was there with another ID, cancel it
        } else if (sellOrders.length == 1) {
            this.error_count++;
            this.sell_order_id = sellOrders[0].orderId;
            print(this.pair, 'CHECK: sell order found with different ID, canceling...');
            await this.cancel_sell();
        }
    }

    /////////////////////////////////////////////////////////
    ///////////////////// CANCEL BUY ////////////////////////
    /////////////////////////////////////////////////////////

    async cancel_buy_error(e) {
        this.error_count++;
        print(symbol, 'Error when canceling buy order, checking orders...', err);
        await this.check_buy_orders();
    }

    cancel_buy_success(res) {
        if (this.log_level >= 2)
            print(symbol, 'Cancel buy order (REST response)');
        delete this.order_id;
    }

    /**
     * Try canceling known this.order_id
     *
     cancel buy order
     not there? ->
     get all orders ->
     cancel all buy orders ->
     continue (delete this.order_id)
     there? ->
     continue (delete this.order_id)

     then ->
     busy = false
     *
     * @return {Promise<void>}
     */
    async cancel_buy() {
        await new Promise((resolve, reject) => {
            binance.cancel(this.pair, this.order_id, (e, res, symbol) => {
                if (e) this.cancel_buy_error(e);
                else this.cancel_buy_success(res);
                resolve();
            });
        });
    };

    CANCELED_LIMIT_BUY() {
        if (this.log_level >= 2)
            print(this.pair, `CANCELED_LIMIT_BUY (WS response)`);

        // Can place again (in case first order) ?
        this.setPositionSize();
        this.setMinNotionalState();
        // minNotional ?
        if (this.position_size_is_over_minNotional) {
            this.buy_placed = false; // can now place again
            if (this.log_level >= 3)
                print(this.pair, 'Still has room for buy order.');
        }

        if (!this.cancelling_all_orders)
            this.busy = false;
    }

    /////////////////////////////////////////////////////////
    ///////////////////// PLACE BUY /////////////////////////
    /////////////////////////////////////////////////////////

    /** Handle binance errors when buying
     *
     * Don't print -1015 stack
     * @param {Object} e - Error object
     */
    buy_error(e) {
        if (e.body && typeof e.body == 'string' && JSON.parse(e.body).code == -1015) {
            console.error(this.pair, '-1015');
        } else {
            this.error_count++;
            print(this.pair, 'Error when placing Limit Buy.', e);

            // Can place again?
            this.setPositionSize();
            this.setMinNotionalState();
            // minNotional ?
            if (this.position_size_is_over_minNotional) {
                this.buy_placed = false; // can now place again
                if (this.log_level >= 3)
                    print(this.pair, 'Still has room for buy order.');
            }
        }
        this.busy = false;
    }

    buy_success(res) {
        if (this.log_level >= 3)
            print(this.pair, 'Limit Buy success (REST response)');
    }

    /** BUY
     *
     * conditions
     *  - Is not stopped or busy
     *  - quantity of position_size would be over minNotional
     *  - concurrent count
     *
     * @return {Promise<void>}
     */
    async place_buy_order() {
        if (this.validate() !== true) return;
        this.busy = true;

        if (this.log_level >= 2)
            print(this.pair, 'Placing limit buy...');

        // Set and get position_size
        const positionSize = this.setPositionSize();

        // Check min notional
        this.setMinNotionalState();
        if (!this.position_size_is_over_minNotional) {
            if (this.log_level >= 3)
                print(this.pair, 'Position size of buy would be under minNotional, not buying.');
            this.busy = false;
            return;
        }

        // Check conc count
        if (this.S.getConcurrent() !== true) {
            if (this.log_level >= 3)
                print(this.pair, 'Concurrent count, not buying and canceling already placed buy order.');
            await this.cancel_buy();
            return;
        }

        // Place buy
        await new Promise((resolve, reject) => {
            binance.buy(this.pair, positionSize, this.rnd(this.buy_line).toFixed(8), {type: 'LIMIT'}, (e, res) => {
                if (e) this.buy_error(e);
                else this.buy_success(res);
                resolve();
            });
        });
    }

    NEW_LIMIT_BUY(data) {
        this.buy_count++;
        const price = parseFloat(data.p);
        const qty = parseFloat(data.q);
        this.buy_placed = true;
        this.last_buy_line = this.buy_line;
        this.order_id = data.i;
        this.position_size = price / qty;
        this.busy = false;

        if (this.log_level >= 2)
            print(this.pair, `NEW_LIMIT_BUY at price: ${price} (WS response)`);
    }

    /////////////////////////////////////////////////////////
    ///////////////////// CANCEL SELL ///////////////////////
    /////////////////////////////////////////////////////////

    async cancel_sell_error(e) {
        this.error_count++;
        print(symbol, 'Error when canceling sell order, checking orders...', err);
        await this.check_sell_orders();
    }

    cancel_sell_success(res) {
        if (this.log_level >= 2)
            print(symbol, 'Cancel sell order (REST response)');
        delete this.sell_order_id;
    }

    async cancel_sell() {
        await new Promise((resolve, reject) => {
            binance.cancel(this.pair, this.sell_order_id, (e, res, symbol) => {
                if (e) this.cancel_sell_error(e);
                else this.cancel_sell_success(res);
                resolve();
            });
        });
    };

    CANCEL_LIMIT_SELL() {
        if (this.log_level >= 2)
            print(this.pair, `CANCELED_LIMIT_SELL (WS response)`);
        if (!this.cancelling_all_orders)
            this.busy = false;
    }

    /////////////////////////////////////////////////////////
    ///////////////////// PLACE SELL ////////////////////////
    /////////////////////////////////////////////////////////

    sell_error(e) {
        this.error_count++;
        print(this.pair, 'Error when placing Limit Sell.', e);

        // Can place again?
    }

    sell_success(res) {

    }

    async place_sell_order() {
        if (this.validate() !== true) return;
        this.busy = true;

        if (this.log_level >= 2)
            print(this.pair, 'Placing limit sell...');

        await new Promise((resolve, reject) => {

            const qty = binance.roundStep(this.balance_available, this.stepSize);

            binance.sell(this.pair, qty, this.rnd(this.sell_line).toFixed(8), {type: 'LIMIT'}, (e, res) => {
                if (e) this.sell_error(e);
                else this.sell_success(res);
                resolve();
            });
        });
    }

    /////////////////////////////////////////////////////////
    ///////////////////// BUY FILL //////////////////////////
    /////////////////////////////////////////////////////////

    /** Triggered by all buy event functions => means theres room for re-selling.
     *
     *
        check ->
            - State is valid? (not stopped or busy)
            - Whats in queue? (DONT place new one)
            - position size of sell (>= minNotional)
     *
     *  gucci? ->
            cancel sell order ->
                err? ->
                    get orders // check orders ->
                        cancel orders ->
                            continue (delete order id and place sell)
                no err? ->
                    continue (delete order id and place sell)

     */
    async handle_buy_fill() {
        const isValid = this.validate();
        const is_in_queue = this.limiter.getInfo(Pair, 'place_buy_order') == true;

        if (isValid && !is_in_queue && this.quantity_available_is_over_minNotional) {
            this.busy = true;

            if (this.log_level >= 3)
                print(this.pair, 'Placing a sell order in queue...');

            if (this.sell_order_id)
                await this.cancel_sell();

            await this.limiter.limit('unshift', 'place_sell_order', this);

        } else if (this.log_level >= 2) {
            print(this.pair, `Cannot place sell. In queue? ${is_in_queue}, Valid? ${isValid}, minNot? ${this.quantity_available_is_over_minNotional}`);
        }
    }

    PARTIALLY_FILLED_LIMIT_BUY(data) {
        this.isConcurrent = true;
        this.last_executed_price = parseFloat(data.L);
        this.last_executed_qty_btc = parseFloat(data.Y); // only for logging
        this.cummulative_qty_btc = parseFloat(data.Z);
        this.percent_filled = Math.round(this.cummulative_qty_btc / this.positionSizeInBTC * 100);
        this.order_id = data.i;

        print(this.pair, `PARTIALLY_FILLED_LIMIT_BUY ${this.last_executed_qty_btc} btc (${this.percent_filled}%) at price: ${this.last_executed_price}`);

        this.handle_buy_fill();
    }

    FILLED_LIMIT_BUY(data) {
        this.isConcurrent = true;
        this.buy_placed = false;
        this.buy_filled = true;
        this.order_id = data.i;

        print(this.pair, `FILLED_LIMIT_BUY ${this.last_executed_qty_btc} btc (${this.percent_filled}%) at price: ${this.last_executed_price}`);

        this.handle_buy_fill();
    }
}

module.exports = Pair;