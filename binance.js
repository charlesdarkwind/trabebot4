const Binance = require('node-binance-api');
const moment = require('moment');

const binance = new Binance().options({
    test: true,
    APIKEY: process.env.APIKEY,
    APISECRET: process.env.APISECRET,
    useServerTime: true,
    recvWindow: 20000,
    verbose: true,
    log(...args) {
        console.warn(
            Array.prototype.slice.call(args),
            moment().format('MMM D, H:mm:ss')
        );
    }
});

module.exports = binance;