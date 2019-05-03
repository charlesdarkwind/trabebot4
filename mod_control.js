require('dotenv').config({path: 'variables.env'});
const fs = require('fs');

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






/**
 * START
 *
 * So when program starts, it:
 *      1. Create pairs objs, fetch exchange infos, fetch balances
 *      2. calls python process 1, fetching missing klines
 *      3. THEN calls python process 2, calculating all model dataframes
 *
 * @return {Promise<void>}
 */
const start = async () => {

    S.createPairs();            // Create Pairs instances
    await S.setInfo();          // fetch exchange infos (REST)
    await S.initBalances();     // fetch balances (REST)
    await S.callPythonKlines(); // Fetch missing 15m klines via python script sub-process
    await S.callDfRecalc();     // Calculate Dataframes

    // Start order updates stream


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