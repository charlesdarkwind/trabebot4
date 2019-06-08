const binance = require('./binance');
const pairs = JSON.parse(fs.readFileSync('./pairs.json')).pairs;

const start = async () => {
  let orders = await new Promise((resolve, reject) => {
      binance.openOrders(false, (e, openOrders) => {
          if (e) console.error(e);
          else resolve(orders);
      });
  });
};

start();

// async checkOrders() {
//     let orders = await new Promise((resolve, reject) => {
//         binance.openOrders(false, (e, openOrders) => {
//             if (e) print('system', 'Error when querying open orders', e);
//             else resolve(openOrders);
//         });
//     });
//     await Promise.all(this.pairs.map(async pair => {
//         const Pair = this.Pairs[pair];
//         if (!Pair.busy) {
//             const buyOrders = orders.filter(order => order.side == 'BUY' && order.symbol == this.pair);
//             const sellOrders = orders.filter(order => order.side == 'SELL' && order.symbol == this.pair);
//             await Pair.check_buy_orders(buyOrders);
//             await Pair.check_sell_orders(sellOrders);
//         }
//     }));
// }