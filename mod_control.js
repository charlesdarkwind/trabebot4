require('dotenv').config({path: 'variables.env'});
const fs = require('fs');
const binance = require('./binance');
const Session = require('./mod_session');
const Limiter = require('./mod_limiter');
const {print} = require('./mod_helpers');
const {mod_data} = require('./mod_data');
const moment = require('moment');
const format = 'MMM D, H:mm:ss';

process.on('uncaughtException', err => console.log(err));
process.on('unhandledRejection', (reason, p) => console.warn('Unhandled Rejection at: Promise', p, 'reason:', reason));

const options = {
    log_level: 3, // 1: normal, 2: a bit spammy, 3: everything
    concurent_count_max: 6,
    position_divider_default: 70.5,
    position_divider: 300,
    num_pairs: 10
};

/** START
 *
 *
 * So when program starts, it:
 *
 *      1. Create pairs objs                                    ()
 *
 *      2. fetch exchange infos                                 (REST)
 *
 *      3. fetch balances                                       (REST)
 *
 *      4. Call python program 1, fetching missing klines       (REST   PYTHON)
 *
 *      5. Call python program 2, calculating dataframes        (PANDAS PYTHON)
 *
 *      6. Start order updates stream                           (WEB SOCKET)
 *
 *
 * @return {Promise<void>}
 */
const start = async () => {
    const limiter = new Limiter();
    const S = new Session(limiter, options);
          S.createPairs(limiter, options);          // Create Pairs instances
    await S.setInfo();              // fetch exchange infos                                     (REST)
    await S.initBalances();         // fetch balances                                           (REST)
    // await S.callPythonKlines();     // Call python program 1, fetching missing klines           (REST   PYTHON)
    // await S.callDfRecalc();         // Call python program 2, calculating dataframes            (PANDAS PYTHON)
    S.parseDF();                    // Read tresholds file

    /** open Trades Updates (Synchronous)
     *
     * Open stream of updates for orders, trades, execution state, ect...
     *
     * Need to pass it actual Session instance
     */
    binance.websockets.userData(data => S.balanceUpdate(data, S), data => S.executionUpdate(data, S));

    setTimeout(async () => {
        await S.placeFirstBuys();
    }, 2000);

    /**
     * INTERVAL: Update exchange infos every 2 hours
     *
     *
     * */
    const update = async () => {
        await S.setInfo();
    };
    setInterval(update, 60000 * 60 * 2); // 2h

    /**
     * INTERVAL: Decrement pairs buy & error counts every 10 mins
     * INTERVAL: recalc dfs
     *
     * */
    setInterval(async () => {
        S.decrementCounts();
        await S.callPythonKlines();     // Call python program 1, fetching missing klines           (REST   PYTHON)
        await S.callDfRecalc();         // Call python program 2, calculating dataframes            (PANDAS PYTHON)
    }, 60000 * 10); // 10m
};

start();