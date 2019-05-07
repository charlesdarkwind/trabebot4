require('dotenv').config({path: 'variables.env'});
const fs = require('fs');
const binance = require('./binance');
const Session = require('./mod_session');
const {print} = require('./mod_helpers');
const {mod_data} = require('./mod_data');
const moment = require('moment');
const format = 'MMM D, H:mm:ss';

process.on('uncaughtException', err => console.log(err));
process.on('unhandledRejection', (reason, p) => console.warn('Unhandled Rejection at: Promise', p, 'reason:', reason));

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
    const S = new Session();
          S.createPairs();          // Create Pairs instances                                   ()
    await S.setInfo();              // fetch exchange infos                                     (REST)
    await S.initBalances();         // fetch balances                                           (REST)
    await S.callPythonKlines();     // Call python program 1, fetching missing klines           (REST   PYTHON)
    await S.callDfRecalc();         // Call python program 2, calculating dataframes            (PANDAS PYTHON)
          S.openTradesUpdates();    // Start order updates stream                               (WEB SOCKET)
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
     *
     *
     * */
    setInterval(() => {
        S.decrementCounts();
    }, 60000 * 10); // 10m
};

start();