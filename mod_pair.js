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

    rnd(num, pair) {
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

    /**
     * Calculate position size that can be bought considering what is already bought.
     * Round it with respect to LOT_SIZE.
     * Set the float converted as attribute
     *
     * @return {string} position size string
     */
    setPositionSize() {
        const totalBTC = this.S.balance_btc_available + this.S.balance_btc_in_order;
        const positionSizeMax = totalBTC / 70.5;
        const positionSizeRaw = (positionSizeMax - this.total_balance * this.buy_line) / this.buy_line;
        const positionSize = binance.roundStep(positionSizeRaw, P.stepSize);
        this.position_size = parseFloat(position_size);
        return positionSize;
    }

    /**
     Execution types:
     NEW
     CANCELED
     REJECTED
     TRADE
     EXPIRED
     {
      "s": "ETHBTC",                 // Symbol *
      "S": "BUY",                    // Side *
      "o": "LIMIT",                  // Order type *
      "q": "1.00000000",             // Order quantity *
      "p": "0.10264410",             // Order price *
      "C": "null",                   // Original client order ID; This is the ID of the order being canceled *
      "x": "NEW",                    // Current execution type *    if status is FILLED, this will be TRADE
      "X": "NEW",                    // Current order status *      FILLED CANCELED NEW
      "r": "NONE",                   // Order reject reason; will be an error code. *
      "i": 4293153,                  // Order ID *
      "l": "0.00000000",             // Last executed quantity *
      "z": "0.00000000",             // Cumulative filled quantity *
      "L": "0.00000000",             // Last executed price *
      "n": "0",                      // Commission amount *
      "T": 1499405658657,            // Transaction time
      "t": -1,                       // Trade ID
      "O": 1499405658657,            // Order creation time
      "Z": "0.00000000",             // Cumulative quote asset transacted quantity
      "Y": "0.00000000"              // Last quote asset transacted quantity (i.e. lastPrice * lastQty) *
    }
     */

    /**
     * Shouldnt have more than 6 buys or errors per hour.
     * If the state is deemed incorrect, stop pair. If pair is already stopped,
     * check if it can be restarted.
     *
     * @return {boolean}
     */
    validate() {
        if (this.busy === true) return false;
        if (!this.stopped) {
            if (this.buy_count > 6 || this.error_count > 6) {
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


    NEW_LIMIT_BUY(data) {
        this.buy_count++;
        const price = parseFloat(data.p);
        const qty = parseFloat(data.q);
        this.buy_placed = true;
        this.last_buy_line = this.buy_line;
        this.order_id = data.i;
        this.position_size = price / qty;
        this.busy = false;
        print(this.pair, `NEW_LIMIT_BUY at price: ${price}`);
    }

    CANCELED_LIMIT_BUY() {
        print(this.pair, `CANCELED_LIMIT_BUY`);
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



    /**
     * wait 2 seconds in case other fill goes thru
     *
     * Needs 20% position size
     * at least 20% more qty than last order
     */
    async place_sell_orders() {
        if (this.validate() !== true || this.percent_filled < 0.2) return;
        this.busy = true;
        let err, res;

        if (this.buy_filled === true) {
            [err, res] = await to(sell(this.pair, this.setPositionSize(), this.sell_line, {type: 'LIMIT'}));
            if (err) this.buyError(err);
            else this.buy_count++;
        }

    }

    /**
     * Handle binance errors when buying
     * Don't print -1015 stack
     * @param {Object} e - Error object
     */
    buyError_buy(e) {
        if (e.body && typeof e.body == 'string' && JSON.parse(e.body).code == -1015) {
            console.error(this.pair, '-1015');
        } else {
            this.error_count++;
            this.buy_placed = false; // can now place again
            print(pair, 'Error when placing Limit Buy.', err, this); // todo dumping this = huge log
        }
        this.busy = false;
    }

    async place_buy_order() {
        this.busy = true;
        let err, res;

        [err, res] = await to(buy(this.pair, this.setPositionSize(), this.buy_line, {type: 'LIMIT'}));
        if (err) this.buyError_buy(err);
    }

    /** Triggered by all sell event functions => means theres room for buying.
     *
     * Can it place a buy order?
     *  - Whats in queue? (Just DONT place new one of same side)
     *  - State is valid? (not stopped)
     *  - Concurent count? (less than options.concurent_count_max)
     */
    async handle_sell() {
        const is_in_queue = this.limiter.getInfo(Pair, 'place_buy_order') == true;
        const isValid = this.validate();
        const is_concurents_ok = this.S.getConcurrent() < this.S.options.concurent_count_max;

        if (isValid && !is_in_queue && is_concurents_ok)
            await this.limiter.limit('push', 'place_buy_order', this);
        else
            print(this.pair, `Cant place buy order ${is_in_queue} ${isValid} ${is_concurents_ok}`); // todo remove / debug only
    }

    PARTIALLY_FILLED_LIMIT_BUY(data) {
        this.isConcurrent = true;
        this.last_executed_price = parseFloat(data.L);
        this.last_executed_qty_btc = parseFloat(data.Y); // only for logging
        this.cummulative_qty_btc = parseFloat(data.Z);
        this.percent_filled = Math.round(this.cummulative_qty_btc / this.position_size * 100);
        this.order_id = data.i;
        print(this.pair, `PARTIALLY_FILLED_LIMIT_BUY ${this.last_executed_qty_btc} btc (${this.percent_filled}%) at price: ${this.last_executed_price}`);

        this.handle_sell();
    }

    FILLED_LIMIT_BUY(data) {
        this.isConcurrent = true;
        this.buy_placed = false;
        this.buy_filled = true;
        this.order_id = data.i;
        print(this.pair, `FILLED_LIMIT_BUY ${last_executed_qty_btc} btc (${percent_filled}%) at price: ${last_executed_price}`);

        this.handle_sell();
    }
}

module.exports = Pair;