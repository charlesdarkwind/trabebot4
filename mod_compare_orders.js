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

    // Get list of orders openned
    let orders = await new Promise((resolve) => {
        binance.openOrders(false, (e, openOrders) => {
            if (e) console.error(e);
            else resolve(openOrders);
        });
    });

    const dict = {};
    const symbols = [];

    orders.map(order => {

        // Init object entry for pair, an obj with count of sells and buys
        if (!dict[order.symbol]) {
            dict[order.symbol] = {
                BUY: 0,
                SELL: 0
            }
        }

        if (order.side == 'BUY') dict[order.symbol].BUY += 1;
        else if (order.side == 'SELL') dict[order.symbol].SELL += 1;

        // Save pair name
        symbols.push(order.symbol);
    });

    // check for bot pairs wich have no orders at all
    pairs.map(pair => {
        if (!symbols.includes(pair)) console.log(`${pair} has no orders!`);
    });

    // Check for pairs in orders with more than one buy or sell
    symbols.map(symbol => {
        if (dict[symbol].BUY > 1) console.log(`${symbol} has many buys!`);
        if (dict[symbol].SELL > 1) console.log(`${symbol} has many sells!`);
    });
};

start();
