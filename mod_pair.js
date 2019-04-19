import binance from "./binance";

const buy = require(binance.buy);
const to = require('./mod_helpers').to;
const {print} = require('./mod_helpers');
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
        this.concurent_count = 0;
        this.partial_fill_prices_buy = [];
        this.partial_fill_prices_sell = [];
        this.last_sell_placed_time = Date.now()
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
     * Set the float converted as aattribute
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
      "E": 1499405658658,            // Event time *
      "s": "ETHBTC",                 // Symbol *
      "c": "mUvoqJxFIILMdfAW5iGSOW", // Client order ID
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


    NEW_LIMIT_BUY(data) {
        const price = parseFloat(data.p);
        const qty = parseFloat(data.q);
        this.buy_placed = true;
        this.last_buy_line = this.buy_line;
        this.order_id = data.i;
        this.position_size = price / qty;
        this.busy = false;

        print(this.pair, `NEW_LIMIT_BUY at price: ${price}`);
    }

    /**
     * Query orders for a pair
     * @return {Promise<void>}
     */
    async order_infos() {

    }

    async cancel_sell() {
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
    handle_sell() {

        this.is_about_to_sell = true;
        this.planned_sell_time = Date.now() + 2000;

        if (this.percent_filled < 20 ||)

        // place sell
            this.last_sell_placed_time = Date.now()
    }

    PARTIALLY_FILLED_LIMIT_BUY(data) {
        this.concurent_count = true; // todo handle concurent count at the session level
        this.last_buy_filled_time = Date.now();
        this.last_executed_price = parseFloat(data.L);
        this.last_executed_qty_btc = parseFloat(data.Y);
        this.cummulative_qty_btc = parseFloat(data.Z);
        this.percent_filled = Math.round(this.cummulative_qty_btc / this.position_size * 100);

        print(this.pair, `PARTIALLY_FILLED_LIMIT_BUY ${this.last_executed_qty_btc} btc (${this.percent_filled}%) at price: ${this.last_executed_price}`);

        this.handle_sell();
    }

    FILLED_LIMIT_BUY(data) {
        this.concurent_count = true; // todo
        this.buy_placed = false;
        this.buy_filled = true;
        print(this.pair, `FILLED_LIMIT_BUY ${last_executed_qty_btc} btc (${percent_filled}%) at price: ${last_executed_price}`);
    }

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

    /**
     * Handle binance errors when buying
     * Don't print -1015 stack
     * @param {Object} e - Error object
     */
    buyError(e) {
        if (e.body && typeof e.body == 'string' && JSON.parse(e.body).code == -1015) {
            console.error(this.pair, '-1015');
        } else {
            this.error_count++;
            this.buy_placed = false; // can now place again
            // Log normal error + some dumps todo
            // print(pair, 'Error when placing Limit Buy.', err, JSON.stringify({
            //     name,
            //     positionSize,
            //     positionSizeRaw,
            //     buyLine: P.buyLine,
            //     totalBalance: P.totalBalance
            // }));
        }
        this.busy = false;
    }

    async placeBuyOrder() {
        if (this.validate() !== true) return;

        this.busy = true;
        let err, res;

        [err, res] = await to(buy(this.pair, this.setPositionSize(), this.buy_line, {type: 'LIMIT'}));
        if (err) this.buyError(err);
        else this.buy_count++;
    }
}

module.exports = Pair;