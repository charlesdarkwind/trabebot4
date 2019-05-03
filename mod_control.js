require('dotenv').config({path: 'variables.env'});
const fs = require('fs');
const { spawn } = require('child_process');
// const { Pair } = require('./mod_pair');
const {Session} = require('./mod_session');
const S = new Session(binance);
const {print} = require('./mod_helpers');
const {mod_data} = require('./mod_data');
const binance = require('./binance');
const moment = require('moment');
const format = 'MMM D, H:mm:ss';

process.on('uncaughtException', err => console.log(err));
process.on('unhandledRejection', (reason, p) => console.warn('Unhandled Rejection at: Promise', p, 'reason:', reason));

const balanceUpdate = data => { // todo will spam a lot in partial fills
    setImmediate(() => {
        for (const obj of data.B) {
            const {a: asset, f: available, l: onOrder} = obj;
            const pair = `${asset}BTC`;
            if (!S.pairs.includes(pair)) return;
            const P = this.Pairs[pair];
            if (!session.balances[asset]) session.balances[asset] = {}; // First call for coin
            const avail = parseFloat(available);
            const order = parseFloat(onOrder);
            P.balance_available = avail;
            P.balance_in_order = order;
        }
    });
};

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
 * @param data
 */

const executionUpdate = data => { // todo will spam a lot in partial fills
    const pair = data.s;
    if (!S.pairs.includes(pair)) return;

    const P = S.Pairs[pair];
    const func = `${data.X}_${data.o}_${data.S}`; // eg. FILLED_LIMIT_BUY  NEW_LIMIT_BUY
    P[func](data);

    // const date = moment(time).format(format);
    // const avgPrice = parseFloat(cumQty) / parseFloat(cumFilledQty);
    // console.log(`${date}, ${executionType}, ${symbol}, price: ${price}, qty: ${quantity}, side: ${side}, type: ${orderType} status: ${orderStatus}`);
    // console.log(`Last executed price: ${L}, last quote asset transacted quantity (i.e. lastPrice * lastQty): ${Y}`);
    // console.log(`Averageprice: ${avgPrice}`);
};




/**
 * START
 *
 * So when program starts, it:
 *      1. Create pairs objs, fetch exchange infos, fetch balances
 *      1. calls python process 1, fetching missing klines
 *      2. THEN calls python process 2, calculating all model dataframes
 *
 * @return {Promise<void>}
 */
const start = async () => {

    S.createPairs();        // Create Pairs instances
    await S.setInfo();      // fetch exchange infos (REST)
    await S.initBalances(); // fetch balances (REST)

    // Start order updates stream
    binance.websockets.userData(balanceUpdate, executionUpdate);

    // Call python process 1, fetching missing klines



    ///////////////////////////////////////////////////////////
    ////////////////  Update Intervals  ///////////////////////
    ///////////////////////////////////////////////////////////
    /**
     * Update exchange infos and stuff every now and then
     */
    const update = async () => {
        await S.setInfo();
    };
    setInterval(update, 60000 * 60 * 2); // 2h

    /**
     * Decrement pairs buy & error counts every 10 mins
     */
    setInterval(() => {
        S.decrementCounts();
    }, 60000 * 10); // 10m
};

start();