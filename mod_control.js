require('dotenv').config({path: 'variables.env'});
const fs = require('fs');
const mongoose = require('mongoose');

process.on('uncaughtException', err => {
    console.log(err);
});

process.on('unhandledRejection', (reason, p) => {
    console.warn('Unhandled Rejection at: Promise', p, 'reason:', reason);
});

mongoose.set('useFindAndModify', false);
mongoose.connect(process.env.DATABASE, {
    useNewUrlParser: true,
    reconnectTries: Number.MAX_VALUE,
    reconnectInterval: 2000
});
mongoose.Promise = global.Promise;
mongoose.connection.on('error', err => console.warn(`mongoose connection error: ${err}`));

const options = {
    log_level: 3, // 1: normal, 2: a bit spammy, 3: everything
    concurent_count_max: 20,
    position_divider_default: 70.5,
    position_divider: 70.5,
    num_pairs: 70
};

require('./models/Log');
const binance = require('./binance');
const Session = require('./mod_session');
const Limiter = require('./mod_limiter');
const { print, repairDatabase } = require('./mod_helpers');
const {mod_data} = require('./mod_data');
const moment = require('moment');
const format = 'MMM D, H:mm:ss';

/** START
 *      1. Create pairs objs
 *      2. fetch exchange infos                                 REST
 *      3. fetch balances                                       REST
 *      4. Call python program 1, fetching missing klines       REST   PYTHON
 *      5. Call python program 2, calculating dataframes        PANDAS PYTHON
 *      6. Start order updates stream                           WEB SOCKET
 *      7. Place first buys after 2 seconds                     REST + WEB SOCKET
 *
 * @return {Promise<void>}
 */
const start = async () => {
    const limiter = new Limiter();
    const S = new Session(limiter, options);
    S.createPairs(limiter, options);
    await S.setInfo();
    await S.initBalances();
    await S.callPythonKlines();
    await S.callDfRecalc();

    /** Open stream of updates for orders  (trades, execution state, ect...)
     *  Need to pass it actual Session instance
     */
    binance.websockets.userData(data => S.balanceUpdate(data, S), data => S.executionUpdate(data, S));

    /** Place first buys in 2 seconds */
    setTimeout(async () => {
        await S.placeFirstBuys();
    }, 2000);

    /** 48 hours
     *  INTERVAL:
     *      - compact database
     * */
    setInterval(repairDatabase, 60000 * 60 * 48);

    /** 2 hours
     *  INTERVAL:
     *      - Update exchange infos
     * */
    setInterval(async () => {
        await S.setInfo();
    }, 60000 * 60 * 2);

    /** 10 mins
     *  INTERVAL:
     *      1. Decrement pairs buy & error counts
     * */
    setInterval(async () => {
        S.decrementCounts();
    }, 60000 * 10);

    /** 2 mins
     *  INTERVAL:
     *      - Re-start pairs with no buys because of:
     *          - Concurent count buy cancel
     *          - re-start stopped for no reason that are due to trade again
     */
    setInterval(async () => {
        await S.handleStoppedForConcurrent();
        await S.handleStoppedForAnyReason();
    }, 60000 * 2);

    /** 30 sec
     *  INTERVAL:
     *      - Check concurent count, stop all orders if busted. (Its already being checked before every order placement)
     *      - Check for pairs with unassessed coin balance to sell
     */
    setInterval(async () => {
        await S.handleConcurentCount();
    }, 30000);

    /** 1 secs
     *
     */
    setInterval(async () => {
        S.recalc();
        await S.handleBalanceChanges();
    }, 1000);

    /**
     * Refill token bucket
     */
    setInterval(() => {
        if (limiter.getTokenCount() < 10)
            limiter.setTokenCount(1);
    }, 105);

    /**
     * run queue
     */
    setInterval(() => {
        limiter.runQueue();
    }, 80);
};

start();