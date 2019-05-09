const os = require('os');
const binance = require('./binance');
const fs = require('fs');
const moment = require('moment');
const {print} = require('./mod_helpers');
const {spawn} = require('child_process');
const Pair = require('./mod_pair');
const util = require('util');
// const readFile = util.promisify(fs.readFile);
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
        this.log_level = options.log_level;
        this.concurrent_count = 0;
        this.pairs_excluded = JSON.parse(fs.readFileSync('./pairs.json')).pairs_excluded;
        this.pairs = JSON.parse(fs.readFileSync('./pairs.json')).pairs;
        this.Pairs = {};

        if (os.platform() == 'win32')
            this.thresh_path = 'W:\\backtester4\\datasets\\main\\tresholds.json';
        else
            this.thresh_path = 'home/jasmin/tresholds.json';
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
            const PRICE_FILTERS = info.filters.find(obj => obj.filterType === 'PRICE_FILTER');
            P.stepSize = info.filters.find(obj => obj.filterType == 'LOT_SIZE').stepSize;
            P.ticksize = parseFloat(PRICE_FILTERS.tickSize);
            P.precision = PRICE_FILTERS.tickSize.split('.')[1].split('1')[0].length + 1 || 0;
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
        const balances = await getBalances();
        for (const asset in balances) {
            const pair = asset + 'BTC';
            if (this.pairs.includes(pair)) {
                const P = this.Pairs[pair];
                P.balance_available = parseFloat(balances[asset].available);
                P.balance_in_order = parseFloat(balances[asset].onOrder);
            } else if (asset === 'BTC') {
                this.balance_btc_available = parseFloat(balances[asset].available) || 0;
                this.balance_btc_in_order = parseFloat(balances[asset].onOrder) || 0;
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
     */
    executionUpdate(data, S) { // todo will spam a lot in partial fills
        const pair = data.s;
        if (!S.pairs.includes(pair)) return;
        const P = S.Pairs[pair];
        const func = `${data.X}_${data.o}_${data.S}`; // eg. FILLED_LIMIT_BUY  NEW_LIMIT_BUY
        P[func](data);
    }

    /** Place all initial buy orders
     *
     * @return {Promise<void>}
     */
    async placeFirstBuys() {
        // await this.limiter.limit('push', 'place_buy_order', this.Pairs['ZENBTC']);
        for (let pair in this.Pairs) {
            const Pair = this.Pairs[pair];
            await this.limiter.limit('push', 'place_buy_order', Pair);
        }
    }

    /**
     * Read and parse tresholds file from PY_2/backtester4, then assign each pair.
     *
     * Expected raw JSON format:
     * {
     *     "time": [],
     *     "ADABTC": {
     *         "buy_line": [],
     *         "sell_line": []
     *     }
     * }
     */
    parseDF() {
        this.tresholds = JSON.parse(fs.readFileSync(this.thresh_path));
        for (const pair in this.Pairs) {
            const Pair = this.Pairs[pair];
            const len = this.tresholds[pair].sell_line.length;
            Pair.sell_line = this.tresholds[pair].sell_line[len - 1];
            Pair.buy_line = this.tresholds[pair].buy_line[len - 1];
            // print(pair, `sell line: ${Pair.sell_line}, buy line: ${Pair.buy_line} ${this.tresholds['time'][len - 1]}`);
        }

        const or = this.tresholds['time'].sort((a, b) => a - b);
        const oldest = moment(or[0]).format('MMM D, H:mm');
        const soonest = moment(or[or.length - 1]).format('MMM D, H:mm');
        print('system', `Retrieved tresholds:`);
        print('system', `   Oldest: ${oldest}`);
        print('system', `   Soonest: ${soonest}`);
    }
}

module.exports = Session;