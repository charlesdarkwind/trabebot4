const binance = require('./binance');
const buy = binance.buy;
const to = require('./mod_helpers').to;
const {print} = require('./mod_helpers');
const util = require('util');
const cancel = util.promisify(binance.cancel);
const openOrders = util.promisify(binance.openOrders);

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
        this.sl_pct = 18; // todo stop pair if sl
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
        this.comp_name = process.env['COMPUTERNAME'];
        this.first_buy_placed = false;
        this.buy_try_count = 0;
        this.sell_try_count = 0;
        this.is_handling_place_sell = false;
        this.is_handling_place_buy = false;
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

    async stop() {
        this.stopped = true;
        this.stopped_until = Date.now() + this.stop_time;
        const orders = await this.get_orders();
        const buyOrders = orders.filter(order => order.side == 'BUY' && order.symbol == this.pair);

        if (this.log_level >= 2 && buyOrders.length)
            print(this.pair, 'Found buy orders, canceling those...');

        await this.cancel_all_orders(buyOrders, 'buy');
    }

    restart() {
        this.stopped = false;
        delete this.stopped_until;
    }

    getTotalBalance() {
        return this.balance_available + this.balance_in_order;
    }

    setFilledPercent() {
        this.percent_filled = Math.round(this.getTotalBalance() * this.buy_line / this.positionSizeInBTC * 100);
    }

    /**
     * Shouldnt have more than 6 buys or errors per hour.
     * If the state is deemed incorrect, stop pair. If pair is already stopped,
     * check if it can be restarted.
     *
     * @return {boolean}
     */
    validate() {
        if (!this.stopped) {
            if (this.buy_count > 6 || this.error_count > 6) {

                if (this.log_level >= 2)
                    print(this.pair, `Stopping pair: Too many buys? ${this.buy_count > 6}, Too many err? ${this.error_count > 6}`);

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
        let positionSize = binance.roundStep(this.positionSizeRawInCoin - this.getTotalBalance(), this.stepSize);

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
        this.position_size_is_over_minNotional = this.position_size * this.buy_line >= this.minNotional; // !Needs fresh position_size!
        this.quantity_available_is_over_minNotional = this.balance_available * this.sell_line >= this.minNotional; // todo this quantity is not rounded perfectly
        this.quantity_total_is_over_minNotional = this.getTotalBalance() * this.sell_line >= this.minNotional;
    }

    /**
     * Query orders for a pair
     * @return {Promise<void>}
     */
    async order_infos(res) {
        const order = await openOrders.catch(err => console.log(err));
        print(this.pairs, `Err cancel resp`, err);
    }

    /////////////////////////////////////////////////////////
    ///////////////////// CANCEL ALL ORDERS /////////////////
    /////////////////////////////////////////////////////////

    cancel_all_orders_error(e, side) { // both sell and buys
        this.error_count++;
        print(this.pair, `Cancel all ${side} orders error:`, e);
        if (e.body && typeof e.body == 'string' && JSON.parse(e.body).code == -2011) {
            print(this.pair, 'Unknown order -2011');
        }
    }

    cancel_all_orders_success(res, side) { // both sell and buys
        return;
    }

    async cancel_all_orders(orders, side) { // both sell and buys
        if (this.log_level >= 2)
            print(this.pair, `Cancelling all ${side} orders`);

        this.cancelling_all_orders = true;  // For WS response CANCEL_LIMIT_BUY spam

        await Promise.all(orders.map(order => {
            return new Promise((resolve, reject) => {
                binance.cancel(this.pair, order.orderId, (e, res, symbol) => {
                    if (e) this.cancel_all_orders_error(e, side);
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

    get_orders_error(e) { // both sell and buys
        this.error_count++;
        print(this.pair, 'Error when querying open orders', err);
    }

    async get_orders() { // both sell and buys
        return new Promise((resolve, reject) => {
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
        } else {
            delete this.order_id;
            this.buy_placed = false;
            print(this.pair, 'Pair had no buy orders');
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
        } else {
            delete this.sell_order_id;
            print(this.pair, 'Pair had no sell orders');
        }
    }

    /////////////////////////////////////////////////////////
    ///////////////////// CANCEL BUY ////////////////////////
    /////////////////////////////////////////////////////////

    async cancel_buy_error(e) {
        this.error_count++;
        print(this.pair, `Error when canceling buy order, checking orders... ${this.order_id} ${this.buy_placed}`, e);
        await this.check_buy_orders();
        this.busy = false;  // todo good?
    }

    cancel_buy_success(res) {
        return;
    }

    /**
     * Try canceling known this.order_id
     *
     * cancel buy order
     *  not there? ->
     *      get all orders ->
     *          cancel all buy orders ->
     *              continue (delete this.order_id)
     *  there? ->
     *      continue (delete this.order_id)
     *
     *  then ->
     *      busy = false
     *
     * @return {Promise<void>}
     */
    async cancel_buy() {
        this.busy = true;

        if (this.log_level >= 3)
            print(this.pair, 'Canceling buy...');

        await new Promise((resolve, reject) => {
            binance.cancel(this.pair, this.order_id, (e, res, symbol) => {
                if (e) this.cancel_buy_error(e);
                else this.cancel_buy_success(res);
                resolve();
            });
        });
    };

    async CANCELED_LIMIT_BUY() {
        delete this.order_id;
        this.buy_placed = false;
        if (!this.cancelling_all_orders) this.busy = false;

        if (this.log_level >= 2)
            print(this.pair, `CANCELED BUY, will retry buy...`);

        // Can place again?
        if (!this.S.isConcurrentCountBusted() && !this.stopped)
            await this.handle_place_buy();
    }

    /////////////////////////////////////////////////////////
    ///////////////////// PLACE BUY /////////////////////////
    /////////////////////////////////////////////////////////

    /** Handle binance errors when buying
     *
     * Don't print -1015 stack
     * @param {Object} e - Error object
     */
    async buy_error(e) {
        this.is_handling_place_buy = false;
        if (e.body && typeof e.body == 'string' && JSON.parse(e.body).code == -1015) {
            if (this.log_level >= 2)
                print(this.pair, 'Buy -1015, retrying...');
        } else {
            this.error_count++;
            print(this.pair, 'Error when placing Limit Buy, retrying...', e);
        }
        this.busy = false;

        // Try again
        if (!this.S.isConcurrentCountBusted() && !this.stopped)
            await this.handle_place_buy();
    }

    buy_success(res) {
        return;
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

        // Check balances again
        await this.S.initBalances();

        // Set and get position_size
        const positionSize = this.setPositionSize();
        const price = this.rnd(this.buy_line).toFixed(8);

        if (this.log_level >= 3)
            print(this.pair, `Placing limit buy... qty: ${positionSize} price: ${price}`);

        // Check lot_size (has MinQty)
        if (this.position_size < this.minQty) {
            if (this.log_level >= 2)
                print(this.pair, `Pos size (${positionSize}) of buy would be under minQty (LOT_SIZE), not buying.`);
            this.busy = false;
            return;
        }

        // Check min notional
        this.setMinNotionalState();
        if (!this.position_size_is_over_minNotional) {
            if (this.log_level >= 2)
                print(this.pair, `Pos size of buy would be under minNot, not buying. ${this.getTotalBalance()}`);
            this.busy = false;
            return;
        }

        // Check conc count
        if (this.S.isConcurrentCountBusted()) {
            if (this.log_level >= 2)
                print(this.pair, 'Conc count reached, not buying + canceling pair buys');

            // Check for concurent count handling, canceling every buys of every orders
            await this.S.handleConcurentCount();

            this.stopped_for_concurrent = true;  // set here and at session level only
            this.busy = false;
            return;
        }

        // Place buy
        await new Promise((resolve, reject) => {
            binance.buy(this.pair, positionSize, price, {type: 'LIMIT'}, (e, res) => {
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
        this.last_buy_line = this.buy_line;
        this.NEW_LIMIT_BUY_RECEIVED = true;
        this.order_id = data.i;
        this.buy_placed = true;
        this.busy = false;

        if (this.log_level >= 2)
            print(this.pair, `NEW BUY at price: ${price.toFixed(8)}`);
    }

    /////////////////////////////////////////////////////////
    ///////////////////// CANCEL SELL ///////////////////////
    /////////////////////////////////////////////////////////

    async cancel_sell_error(e) {
        this.error_count++;
        print(this.pair, 'Error when canceling sell order, checking orders...', e);
        await this.check_sell_orders();
        this.busy = false;
    }

    cancel_sell_success(res) {
        return;
    }

    async cancel_sell() {
        this.busy = true;

        if (this.log_level >= 3)
            print(this.pair, 'Canceling sell...');

        await new Promise((resolve, reject) => {
            binance.cancel(this.pair, this.sell_order_id, (e, res, symbol) => {
                if (e) this.cancel_sell_error(e);
                else this.cancel_sell_success(res);
                resolve();
            });
        });
    };

    async CANCELED_LIMIT_SELL() {
        delete this.sell_order_id;
        this.sell_placed = false;
        if (!this.cancelling_all_orders) this.busy = false;

        if (this.log_level >= 2)
            print(this.pair, `CANCELED SELL, will retry sell...`);

        // Can place again ?
        await this.handle_place_sell();
    }

    /////////////////////////////////////////////////////////
    ///////////////////// PLACE SELL ////////////////////////
    /////////////////////////////////////////////////////////

    async sell_error(e) {
        this.is_handling_place_sell = false;
        if (e.body && typeof e.body == 'string' && JSON.parse(e.body).code == -1015) {
            if (this.log_level >= 2)
                print(this.pair, 'Sell -1015, retrying...');
        } else {
            this.error_count++;
            print(this.pair, 'Error when placing Limit Sell, retrying...', e);
        }
        this.busy = false;  // handle_place_sell wont always put busy in true / false

        // try again
        await this.handle_place_sell();
    }

    sell_success(res) {
        return;
    }

    async place_sell_order() {
        if (this.validate() !== true) return;
        this.busy = true;

        // Check balances again
        await this.S.initBalances();

        const qty = binance.roundStep(this.balance_available, this.stepSize);
        const price = this.rnd(this.sell_line).toFixed(8);

        if (this.log_level >= 3)
            print(this.pair, `Placing limit sell... qty: ${qty} price: ${price}`);

        // Check lot_size (has MinQty)
        if (qty < this.minQty) {
            if (this.log_level >= 2)
                print(this.pair, `Pos size (${qty}) of sell would be under minQty (LOT_SIZE), not selling.`);
            this.busy = false;
            return;
        }

        await new Promise((resolve, reject) => {
            binance.sell(this.pair, qty, price, {type: 'LIMIT'}, (e, res) => {
                if (e) this.sell_error(e);
                else this.sell_success(res);
                resolve();
            });
        });
    }

    NEW_LIMIT_SELL(data) {
        const price = parseFloat(data.p);
        const qty = parseFloat(data.q);
        this.NEW_LIMIT_SELL_RECEIVED = true;
        this.last_sell_line = price; // use price reported instead of sell_line so manual orders can be re-placed
        this.sell_order_id = data.i;
        this.sell_placed = true;
        this.busy = false;

        if (this.log_level >= 2)
            print(this.pair, `NEW SELL at price: ${price.toFixed(8)}`);
    }

    /////////////////////////////////////////////////////////
    ///////////////////// SELL FILL /////////////////////////
    /////////////////////////////////////////////////////////

    /** Triggered by all sell event functions -> means theres room for re-buying.
     *
     * Handles all conditions before sending a request of buy order in the limiter
     *
     * conditions (Can it place a buy order) ->
     *      - State is valid? (not stopped)
     *      + Concurent count? (less than options.concurent_count_max)
     *      - minNotional (total coin >= minNotional)
     *      - Whats in queue? (DONT place new BUY)
     *
     *  gucci? ->
     *      busy? ->
     *          wait and retry until not busy
     *      not busy? ->
     *          cancel buy order ->
     *              err? ->
     *                  get orders // check orders ->
     *                      cancel orders ->
     *                          continue (delete order id and place buy)
     *              no err? ->
     *                  continue (delete order id and place buy)
     *
     */
    async handle_place_buy() {

        if (this.is_handling_place_buy) {
            if (this.log_level >= 2)
                print(this.pair, 'Pair is already trying to handle place buy in parallel, returning...');
            return;
        } else this.is_handling_place_buy = true;

        // Retry until not busy, in case canceling, (not supposed to be placing orders since its removing doubles from queue)
        if (this.busy || this.cancelling_all_orders) {

            if (this.log_level >= 2)
                print(this.pair, `Cant place buy in queue, busy, try in 2 secs... ${this.buy_try_count} tries`);

            this.buy_try_count++;

            setTimeout(async () => {
                await this.handle_place_buy();
            }, 2000);

            this.is_handling_place_buy = false;
            return; // Return but retrying
        }
        this.buy_try_count = 0;

        const isValid = this.validate();
        // this.setMinNotionalState();
        // const hasMinNot = this.position_size_is_over_minNotional; // todo should fetch balance before?
        const is_in_queue = this.limiter.getInfo(Pair, 'place_buy_order') == true;

        if (isValid && !is_in_queue && !this.S.isConcurrentCountBusted()/* && hasMinNot*/) { // conditions
            this.busy = true;

            // Cancel other buy
            if (this.order_id)
                await this.cancel_buy();

            if (this.log_level >= 3)
                print(this.pair, 'Placing a buy order in queue...');

            // Place buy order in queue
            await this.limiter.limit('place_buy_order', this);

        } else if (this.log_level >= 2) {
            print(this.pair, `Cant place buy queue: Valid ${isValid} queue ${is_in_queue}`);
        }
        this.is_handling_place_buy = false;
    }

    async PARTIALLY_FILLED_LIMIT_SELL(data) {
        await this.S.initBalances();
        this.isConcurrent = false;
        this.sell_order_id = data.i;
        this.last_executed_price_sell = parseFloat(data.L); // only for logging
        this.setFilledPercent();
        const sellFilledPct = Math.round(this.getTotalBalance() * this.sell_line / this.positionSizeInBTC * 100);
        const lastQty = data.Y;
        const profitPercent = (this.last_executed_price_sell / this.last_executed_price_buy - 1) * 100;

        print(this.pair, `PARTIALL FILLED SELL (${sellFilledPct}%) at price: ${this.last_executed_price_sell.toFixed(8)}, profit: ${profitPercent.toFixed(2)}%`);

        if (!this.is_handling_place_buy)
            this.handle_place_buy();
    }

    async FILLED_LIMIT_SELL(data) {
        await this.S.initBalances();
        this.isConcurrent = false;
        this.sell_placed = false;
        delete this.sell_order_id;
        this.last_executed_price_sell = parseFloat(data.L); // only for logging
        this.percent_filled = 0;
        const lastQty = data.Y;
        const profitPercent = (this.last_executed_price_sell / this.last_executed_price_buy - 1) * 100;

        print(this.pair, `FILLED SELL (0%) at price: ${this.last_executed_price_sell.toFixed(8)}, profit: ${profitPercent.toFixed(2)}%`);

        if (!this.is_handling_place_buy)
            this.handle_place_buy();
    }

    /////////////////////////////////////////////////////////
    ///////////////////// BUY FILL //////////////////////////
    /////////////////////////////////////////////////////////

    /** Triggered by all buy event functions => means theres room for re-selling.
     *
     *   conditions (Can it place a sell order) ->
     *      - State is valid? (not stopped or busy)
     *      - Whats in queue? (DONT place new SELL)
     *      - position size of sell (>= minNotional)
     *
     *  gucci? ->
     *      busy? ->
     *          wait and retry until not busy
     *      not busy? ->
     *          cancel sell order ->
     *              err? ->
     *                  get orders // check orders ->
     *                      cancel orders ->
     *                          continue (delete order id and place sell)
     *              no err? ->
     *                  continue (delete order id and place sell)
     *
     */
    async handle_place_sell() {

        if (this.is_handling_place_sell) {
            if (this.log_level >= 2)
                print(this.pair, 'Pair is already trying to handle place sell in parallel, returning...');
            return;
        } else this.is_handling_place_sell = true;

        // Retry until not busy, in case canceling, (not supposed to be placing orders since its removing doubles from queue)
        if (this.busy || this.cancelling_all_orders) {
            if (this.log_level >= 2)
                print(this.pair, `Cant place sell in queue, busy, try in 2 secs... ${this.sell_try_count} tries`);

            setTimeout(async () => {
                this.sell_try_count++;
                await this.handle_place_sell();
            }, 2000);

            this.is_handling_place_sell = false;
            return; // Return but retrying
        }
        this.sell_try_count = 0;

        const isValid = this.validate();
        const is_in_queue = this.limiter.getInfo(Pair, 'place_sell_order') == true;
        this.setMinNotionalState();

        if (isValid && !is_in_queue && this.quantity_total_is_over_minNotional) { // conditions
            this.busy = true;

            // Cancel other sell
            if (this.sell_order_id) {
                if (this.log_level >= 3)
                    print(this.pair, 'Cancelling old sell order...');

                await this.cancel_sell();
            }

            if (this.log_level >= 3)
                print(this.pair, 'Placing a sell order in queue...');

            // Place sell order in queue
            await this.limiter.limit('place_sell_order', this);

        } else if (this.log_level >= 2) {
            print(this.pair, `Cant place sell: Valid ${isValid} queue ${is_in_queue} minNot ${this.quantity_total_is_over_minNotional}`);
        }
        this.is_handling_place_sell = false;
    }

    async PARTIALLY_FILLED_LIMIT_BUY(data) {
        await this.S.initBalances();
        this.isConcurrent = true;
        this.order_id = data.i;
        this.buy_placed = true;
        this.last_executed_price_buy = parseFloat(data.L); // only for logging
        this.setFilledPercent();

        print(this.pair, `PARTIALL FILLED BUY (${this.percent_filled}%) at price: ${this.last_executed_price_buy}`);

        if (!this.is_handling_place_sell)
            this.handle_place_sell();
    }

    async FILLED_LIMIT_BUY(data) {
        await this.S.initBalances();
        this.isConcurrent = true;
        this.buy_placed = false;
        delete this.order_id;
        this.last_executed_price_buy = parseFloat(data.L); // only for logging
        this.percent_filled = 100;

        print(this.pair, `FILLED BUY (${this.percent_filled}%) at price: ${this.last_executed_price_buy.toFixed(8)}`);

        if (!this.is_handling_place_sell)
            this.handle_place_sell();
    }

    /////////////////////////////////////////////////////////
    //////////////// CANCEL FOR NEW PRICES //////////////////
    /////////////////////////////////////////////////////////

    hasBuyLineDiv() {
        const div = this.last_buy_line / this.buy_line;
        this.div_buy = div;
        return div > 1.004 || div < 0.996;
    }

    hasSellLineDiv() {
        if (!this.last_sell_line) return false;
        const div = this.last_sell_line / this.sell_line;
        this.div_sell = div;
        return div > 1.004 || div < 0.996;
    }

    async handle_new_prices() {
        return new Promise(async (resolve, reject) => {

            if (this.busy || this.cancelling_all_orders) {

                if (this.log_level >= 3)
                    print(this.pair, 'Checking div but is busy, trying again in 5 secs...');

                setTimeout(async () => {
                    if (this.log_level >= 3 && this.busy) { // todo remove
                        print(this.pair, 'Pair still busy after 5s, not normal, removing busy...');
                        this.busy = false; // if still busy after 5s then something wierd happened, remove busy todo keep the = false?
                    }
                    await this.handle_new_prices();
                }, 5000);

                resolve();
                return;
            }

            if (this.order_id && this.hasBuyLineDiv()) {

                if (this.log_level >= 3)
                    print(this.pair, `Cancelling buy for div ${this.div_buy.toFixed(3)}...`);

                // Cancel, (place is attempted after cancel WS response)
                await this.cancel_buy();
            }

            if (this.sell_order_id && this.hasSellLineDiv()) {

                if (this.log_level >= 3)
                    print(this.pair, `Cancelling sell for div ${this.div_sell.toFixed(3)} ...`);

                // Cancel, (place is attempted after cancel WS response)
                await this.cancel_sell();
            }
            resolve();
        });
    }

    /////////////////////////////////////////////////////////
    /////////////////////// OTHER ///////////////////////////
    /////////////////////////////////////////////////////////

    REJECTED_LIMIT_SELL() {
        this.error++;
        this.validate();
    }

    REJECTED_LIMIT_BUY() {
        this.error++;
        this.validate();
    }
}

module.exports = Pair;