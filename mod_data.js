const fs = require('fs');
const print = require('./mod_helpers');
const binance = require('./binance');

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

exports.generateMads = (charts, pairs) => {
    const start = Date.now();
    for (i =)
    print('system', `took ${(Date.now() - start) / 1000} seconds`)
};