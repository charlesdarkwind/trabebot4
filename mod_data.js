const fs = require('fs');
const print = require('./mod_helpers');
import binance from './binance';

/** Async Query exchange infos
 *
 * @returns {Promise<any>}
 */
exports.updateExhangeInfos = () => new Promise(resolve => {
    binance.exchangeInfo((err, data) => {
        if (err) print('system', 'Err while querying exchange infos.', err);
        else resolve(data);
    });
});