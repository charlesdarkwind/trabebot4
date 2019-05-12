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
        this.Pairs = {};
        this.comp_name = process.env['COMPUTERNAME'];
        this.concurrent_cancel_buy = false;

        this.pairs = JSON.parse(fs.readFileSync('./pairs.json')).pairs;
        if (this.options.num_pairs < 70)
            this.pairs = this.pairs.slice(0, this.options.num_pairs);


        if (os.platform() == 'win32' && this.comp_name == 'JAS-PC')
            this.thresh_path = 'W:\\backtester4\\datasets\\main\\tresholds.json';
        else if (os.platform() == 'win32' && this.comp_name == 'JAS-VPS')
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
            P.minNotional = parseFloat(info.filters.find(obj => obj.filterType == 'MIN_NOTIONAL').minNotional);
            P.ticksize = parseFloat(PRICE_FILTERS.tickSize);
            P.precision = PRICE_FILTERS.tickSize.split('.')[1].split('1')[0].length + 1 || 0;
            P.round = 10 ** P.precision;
        }

        if (this.log_level >= 2)
            print('system', 'New exchange infos queried')
    }

    /**
     * Set initial pairs balance via rest, set BTC balances in Session
     * Only for traded pairs and BTC
     *
     * @return {Promise<void>}
     */
    async initBalances() {
        await new Promise(async (resolve, reject) => {
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
            resolve();
        });
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

    /**
     * Return bool of if conc count if OK
     *
     * @return {boolean}
     */
    getConcurrent() {
        let count = 0;
        for (const p in this.Pairs) {
            if (this.Pairs[p].isConcurrent) count++;
        }
        return count < this.options.concurent_count_max;
    }

    /** Re-start "stopped" pair that are due to trade again
     *
     *  conditions:
     *      - pair is stopped
     *      - stopped until reached
     *
     * @return {Promise<void>}
     */
    async handleStoppedForAnyReason() {
        const now = Date.now();
        await Promise.all(this.pairs.map(async pair => {
            const Pair = this.Pairs[pair];
            if (Pair.stopped && now > Pair.stopped_until) {
                print(pair, 'Re-starting stopped pair...');
                Pair.stopped = false;
                delete Pair.stopped_until;
                await Pair.handle_place_buy();
            }
        }));
    }

    /** Re-place buy order for pairs whom buy was canceled because the concurrent count max was reached.
     *
     * Conditions:
     *      - no longer max conc count
     *      - concurrent_cancel_buy prop is true (set it to false if proceeding)
     *      - no order ID prop
     *      - buy_placed prop is false
     *
     * @return {Promise<void>}
     */
    async handleStoppedForConcurrent() {
        if (!this.getConcurrent()) return;
        if (this.concurrent_cancel_buy) this.concurrent_cancel_buy = false;
        await Promise.all(this.pairs.map(async pair => {
            const Pair = this.Pairs[pair];
            if (Pair.concurrent_cancel_buy && !Pair.order_id && !Pair.buy_placed) {
                if (this.log_level >= 2)
                    print(pair, 'Concurrent count diminished, buying again');
                await Pair.handle_place_buy();
                Pair.concurrent_cancel_buy = false;
            }
        }));
    }

    /** Check if buy orders should be canceled because of concurent count.
     *
     * Conditions:
     *      - max conc count reached
     *      - concurrent_cancel_buy prop is true (set it to true)
     *      - has either order_id or buy_placed
     *
     * @return {Promise<void>}
     */
    async handleConcurentCount() {
        if (this.getConcurrent()) return;
        if (!this.concurrent_cancel_buy) this.concurrent_cancel_buy = true;
        print('system', 'Concurent count reached!');
        await Promise.all(this.pairs.map(async pair => {
            const Pair = this.Pairs[pair];
            if (!Pair.concurrent_cancel_buy && (Pair.order_id || Pair.buy_placed)) {
                if (this.log_level >= 2)
                    print(pair, 'Concurrent count reached and pair may have orders, canceling...');
                // Fetch all buy orders
                const orders = await Pair.get_orders();
                const buyOrders = orders.filter(order => order.side == 'BUY' && order.symbol == pair);
                // Cancel all buy orders
                await Pair.cancel_all_orders(buyOrders, 'buy');
                Pair.concurrent_cancel_buy = true;
            }
        }));
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
            if (os.platform() === 'win32' && this.comp_name == 'JAS-PC') {
                ls = spawn('python', ['mod_control.py'], {cwd: 'W:\\fetch_klines'});
            } else if (this.comp_name == 'JAS-VPS' && this.comp_name == 'JAS-VPS') {
                ls = spawn('python', ['mod_control.py'], {cwd: 'C:\\Users\\JAS\\Documents\\fetch_klines'});
            } else {
                ls = spawn('python', ['mod_control.py'], {cwd: '/home/jasmin/fetch_klines'}); // todo: fix path on vps
            }

            if (this.log_level >= 2)
                print('PY_1', 'Writing klines...');

            ls.stdout.on('data', msg => { // Number of new klines and symbol infos printed
                // print('PY_1', msg);
            });

            ls.stderr.on('data', data => {
                print('PY_1', 'Err during python 1 klines fetching (REST)', data.toString());
            });

            ls.on('close', code => {
                if (this.log_level >= 2 || code != 0)
                    print('PY_1', `Python 1 process exited with code ${code}`);
                if (code !== 0) reject();
                resolve();
            });
        });
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

        if (this.log_level >= 2) {
            const or = this.tresholds['time'].sort((a, b) => a - b);
            const oldest = moment(or[0]).format('MMM D, H:mm');
            const soonest = moment(or[or.length - 1]).format('MMM D, H:mm');
            print('system', `Retrieved tresholds:`);
            print('system', `   Oldest: ${oldest}`);
            print('system', `   Soonest: ${soonest}`);
        }
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
            if (os.platform() === 'win32' && this.comp_name == 'JAS-PC') {
                ls = spawn('python', ['mod_control.py'], {cwd: 'W:\\backtester4\\sample'});
            } else if (this.comp_name == 'JAS-VPS' && this.comp_name == 'JAS-VPS') {
                ls = spawn('python', ['mod_control.py'], {cwd: 'W:\\backtester4\\sample'});
            } else {
                // todo: pair must be listed in [pairstotest] from the python mod_data script
                ls = spawn('python', ['mod_control.py'], {cwd: '/home/jasmin/backtester4'});
            }

            if (this.log_level >= 2)
                print('PY_2', 'Recalcing DFs...');

            ls.stdout.on('data', msg => {
                // print('PY_2', msg);
            });

            ls.stderr.on('data', data => {
                print('PY_2', 'Err during python 2 pandas calc', data.toString());
            });

            ls.on('close', code => {
                if (this.log_level >= 2 || code != 0)
                    print('PY_2', `Python 2 process exited with code ${code}`);
                if (code !== 0) reject();

                // Parse DFs
                this.parseDF();
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
    executionUpdate(data, S) {
        const pair = data.s;
        if (!S.pairs.includes(pair)) return;
        const P = S.Pairs[pair];
        const func = `${data.X}_${data.o}_${data.S}`; // eg. FILLED_LIMIT_BUY  NEW_LIMIT_BUY
        try {
            P[func](data);
        } catch (e) {
            print('system', `${func}`);
        }
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

    async handle_new_prices() {
        await Promise.all(this.pairs.map(async pair => await this.Pairs[pair].handle_new_prices()));
    }
}

module.exports = Session;