process.env.UV_THREADPOOL_SIZE = 128;
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
    num_pairs: 70,
    dataOptions: {
        base_dev_lo_mult: 0.99,
        base_dev_hi_mult: 1,
        mad_window: 125,
        sma_base_sell: 20,
        sma_median: 20,
        sma_slope_pair: 20
    }
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
    // await S.initKlineStreams();
    S.writeCharts();
    // setTimeout(() => {
    //     S.writeCharts();
    //
    // }, 12000);

    // const data = JSON.parse(fs.readFileSync('./pairs.json'));
};

start();