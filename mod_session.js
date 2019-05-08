const os = require('os');
const binance = require('./binance');
const fs = require('fs');
const {print} = require('./mod_helpers');
const {spawn} = require('child_process');
const Pair = require('./mod_pair');
const util = require('util');
const readFile = util.promisify(fs.readFile);
// const writeFile = util.promisify(fs.writeFile);
const getExchangeInfos = util.promisify(binance.exchangeInfo);
const getBalances = util.promisify(binance.balance);

/**
 * Session
 *
 * @module charlesdarkwind/tradebot4
 * @return {object} instance to class object
 */
class Session {
    constructor(limiter, options) {
        this.limiter = limiter;
        this.options = options;
        this.concurrent_count = 0;
        this.pairs_excluded = JSON.parse(fs.readFileSync('./pairs.json')).pairs_excluded;
        this.pairs = JSON.parse(fs.readFileSync('./pairs.json')).pairs;
        this.Pairs = {};
    }

    /**
     * Instanciate all pairs
     */
    createPairs() {
        this.pairs.map(pair => {
            this.Pairs[pair] = new Pair(pair, this); // hopefully no circular probs
        });
    }

    /**
     * Update main exchange infos data and for each pairs
     *
     * @returns {Promise<void>}
     */
    async setInfo() {
        this.exchangeInfos = await getExchangeInfos();
        for (const pair in this.Pairs) {
            const P = this.Pairs[pair];
            const info = this.exchangeInfos.symbols.find(pair => pair.symbol === P.pair);
            const filters = info.filters.find(obj => obj.filterType === 'PRICE_FILTER');
            P.ticksize = parseFloat(filters.tickSize);
            P.precision = filters.tickSize.split('.')[1].length | 0;
            P.round = 10 ** P.precision;
        }
    }

    /**
     * Set initial pairs balance via rest, set BTC balances in Session
     * Only for traded pairs and BTC
     *
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
        for (const pair in this.Pairs) {
            const P = this.Pairs[pair];
            P.decrementBuyCounts();
            P.decrementErrorCounts();
        }
    }

    getConcurrent() {
        let count = 0;
        for (const p in this.Pairs) {
            if (this.Pairs[p].isConcurrent) count++;
        }
        return count;
    }

    /**
     * callPythonKlines
     *
     * Calls python process 1, fetching missing klines
     *
     * Klines are written to disk. Can take some time depending on time since last run.
     *
     * dest klines = /home/jasmin/fetch_klines/klines/15m/Binance_BTCUSDT_15m_1533081600000-1554374417584.json
     *
     * @return {Promise<void>}
     */
    async callPythonKlines() {
        return await new Promise((resolve, reject) => {

            let ls = undefined;
            if (os.platform() === 'win32') {
                ls = spawn('python', ['mod_control.py'], {cwd: 'W:\\fetch_klines'});
            } else {
                ls = spawn('python', ['mod_control.py'], {cwd: '/home/jasmin/fetch_klines'}); // todo: fix path on vps
            }

            print('PY_1', 'Writing klines...');

            ls.stdout.on('data', msg => { // Number of new klines and symbol infos printed
                print('PY_1', msg);
            });

            ls.stderr.on('data', data => {
                print('PY_1', 'Err during python 1 klines fetching (REST)', data.toString());
            });

            ls.on('close', code => {
                print('PY_1', `Python 1 process exited with code ${code}`);
                if (code !== 0) reject();
                resolve();
            });
        });
    }

    /** call Df Recalc
     *
     * Calls the python process 2, calculating all models and dataframes, takes lots of time, about 1m.
     *
     * This python programs is the backtester but only some parts are used to encourage code-reusability.
     * The server_mode is set to True in the py prog.
     *
     * @return {Promise<void>}
     */
    async callDfRecalc() {
        return await new Promise((resolve, reject) => {

            let ls = undefined;
            if (os.platform() === 'win32') {
                ls = spawn('python', ['mod_control.py'], {cwd: 'W:\\backtester4\\sample'});
            } else {
                // todo: pair must be listed in [pairstotest] from the python mod_data script
                ls = spawn('python', ['mod_control.py'], {cwd: '/home/jasmin/backtester4'});
            }

            print('PY_2', 'Recalcing DFs...');

            ls.stdout.on('data', msg => {
                print('PY_2', msg);
            });

            ls.stderr.on('data', data => {
                print('PY_2', 'Err during python 2 pandas calc', data.toString());
            });

            ls.on('close', code => {
                print('PY_2', `Python 2 process exited with code ${code}`);
                if (code !== 0) reject();
                resolve();
            });
        });
    }

    getPairs() {
        return this.pairs;
    }

    balanceUpdate(data, S) { // todo will spam a lot in partial fills
        setImmediate(() => {
            for (const obj of data.B) {
                const {a: asset, f: available, l: onOrder} = obj;
                const pair = `${asset}BTC`;
                if (!S.pairs.includes(pair)) return;
                const P = S.Pairs[pair];
                P.balance_available = parseFloat(available);
                P.balance_in_order = parseFloat(onOrder);
            }
        });
    };

    /** Execution Update:
     *
     Types: NEW CANCELED REJECTED TRADE EXPIRED
     "E": 1499405658658,            // Event time *
     "s": "ETHBTC",                 // Symbol *
     "c": "mUvoqJxFIILMdfAW5iGSOW", // Client order ID
     "S": "BUY",                    // Side *
     "o": "LIMIT",                  // Order type *
     "q": "1.00000000",             // Order quantity *
     "p": "0.10264410",             // Order price *
     "C": "null",                   // Original client order ID; This is the ID of the order being canceled *
     "x": "NEW",                    // Current execution type *    if status is FILLED, this will be TRADE
     "X": "NEW",                    // Current order status *      FILLED CANCELED NEW
     "r": "NONE",                   // Order reject reason; will be an error code. *
     "i": 4293153,                  // Order ID *
     "l": "0.00000000",             // Last executed quantity *
     "z": "0.00000000",             // Cumulative filled quantity *
     "L": "0.00000000",             // Last executed price *
     "n": "0",                      // Commission amount *
     "T": 1499405658657,            // Transaction time
     "t": -1,                       // Trade ID
     "O": 1499405658657,            // Order creation time
     "Z": "0.00000000",             // Cumulative quote asset transacted quantity
     "Y": "0.00000000"              // Last quote asset transacted quantity (i.e. lastPrice * lastQty)
     */
    executionUpdate(data, S) { // todo will spam a lot in partial fills
        const pair = data.s;
        if (!S.pairs.includes(pair)) return;
        const P = S.Pairs[pair];
        const func = `${data.X}_${data.o}_${data.S}`; // eg. FILLED_LIMIT_BUY  NEW_LIMIT_BUY
        console.log(func);
        P[func](data);
    }

    /** Place all initial buy orders
     *
     * @return {Promise<void>}
     */
    async placeFirstBuys() {
        for (let pair in this.Pairs) {
            const Pair = this.Pairs[pair];
            await this.limiter.limit('push', 'place_buy_order', Pair);
        }
    }

}

module.exports = Session;