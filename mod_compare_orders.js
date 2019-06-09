require('dotenv').config({path: 'variables.env'});
const binance = require('./binance');
const fs = require('fs');
// noinspection JSCheckFunctionSignatures
const pairs = JSON.parse(fs.readFileSync('./pairs.json')).pairs;

/**Will log any pairs that have no open orders, will exit and not do anything otherwise.
 *
 * @return {Promise<void>}
 */
const start = async () => {
    let orders = await new Promise((resolve) => {
        binance.openOrders(false, (e, openOrders) => {
            if (e) console.error(e);
            else resolve(openOrders);
        });
    });

    const symbols = orders.map(order => order.symbol);

    pairs.map(pair => {
        if (!symbols.includes(pair)) console.log(pair);
    });
};

start();
