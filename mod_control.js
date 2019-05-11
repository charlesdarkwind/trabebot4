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
    concurent_count_max: 4, // todo change
    position_divider_default: 70.5,
    position_divider: 300,
    num_pairs: 20
};

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

    /** 2 hours
     *  INTERVAL:
     *      - Update exchange infos
     * */
    setInterval(async () => {
        await S.setInfo();
    }, update, 60000 * 60 * 2);

    /** 10 mins
     *  INTERVAL:
     *      1. Decrement pairs buy & error counts
     *      2. get klines
     *      3. re-calc models / matrices / DFs
     *      4. Fetch Balances
     *      5. Cancel and place deviating orders (div)
     * */
    setInterval(async () => {
        S.decrementCounts();
        await S.callPythonKlines();
        await S.callDfRecalc();
        await S.initBalances();
        await S.handle_new_prices();
    }, 60000 * 10);

    /** 2 mins
     *  INTERVAL:
     *      - Re-start pairs with no buys because of:
     *          - Concurent count buy cancel
     */
    setInterval(async () => {
        await S.handleStoppedForConcurrent();
    }, 60000 * 2);

    /** 30 sec
     *  INTERVAL:
     *      - Check concurent count, stop all orders if busted. (Its already being checked before every order placement)
     */
    setInterval(async () => {
        await S.handleConcurentCount();
    }, 30000);
};

start();