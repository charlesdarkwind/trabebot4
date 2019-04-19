import fs from 'fs';
import binance from './binance';

const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);
const getExchangeInfos = util.promisify(binance.exchangeInfo);
const getBalances = util.promisify(binance.balance);

/**
 * Session
 * @module charlesdarkwind/tradebot4
 * @return {object} instance to class object
 */
class Session {
    constructor() {
        this.concurrent_count = 0;
        this.pairs_excluded = pairs_excluded;
        this.pairs = [];
        this.Pairs = {};
    }

    /**
     * Instanciate all pairs
     */
    createPairs() {
        this.pairs_prod.map(pair => {
            this.Pairs[pair] = new pair(pair, this); // hopefully no circular probs
        });
    }

    /**
     * Update main exchange infos data and for each pairs
     * @returns {Promise<void>}
     */
    async setInfo() {
        this.exchangeInfos = await getExchangeInfos();
        this.Pairs.map(P => {
            const info = this.exchangeInfos.symbols.find(pair => pair.symbol === P.pair);
            const filters = info.filters.find(obj => obj.filterType === 'PRICE_FILTER');
            P.ticksize = parseFloat(filters.tickSize);
            P.precision = filters.tickSize.split('.')[1].length | 0;
        });
    }

    /**
     * Set initial pairs balance via rest, set BTC balances in Session
     * Only for traded pairs and BTC
     * @return {Promise<void>}
     */
    async initBalances() {
        const balances = await getBalances;
        for (const asset in balances) {
            const pair = asset + 'BTC';
            if (this.pairs.includes(pair)) {
                const P = this.Pairs[pair];
                P.balance_available = parseFloat(balances[asset].available);
                P.balance_in_order = parseFloat(balances[asset].onOrder);
            } else if (asset === 'BTC') {
                this.balance_btc_available = parseFloat(balances[asset].available) | undefined;
                this.balance_btc_in_order = parseFloat(balances[asset].onOrder) | undefined;
            }
        }
    }

    /**
     * Decrement count of buys and errors for each pairs
     */
    decrementCounts() {
        for (const P of this.Pairs) {
            P.decrementBuyCounts();
            P.decrementErrorCounts();
        }
    }
}

module.exports = Session;