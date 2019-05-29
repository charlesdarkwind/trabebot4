const os = require('os');
const binance = require('./binance');
const fs = require('fs');
const moment = require('moment');
const {print} = require('./mod_helpers');
const {spawn} = require('child_process');
const Pair = require('./mod_pair');
const util = require('util');
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
        this.runned_once = false;
        this.PY_1_error_count = 0;  // cant fail 2 times in a row
        this.delay = 0;
        this.error_count = 0;

        this.pairs = JSON.parse(fs.readFileSync('./pairs.json')).pairs;
        if (this.options.num_pairs < 70)
            this.pairs = this.pairs.slice(0, this.options.num_pairs);


        if (os.platform() == 'win32' && this.comp_name == 'JAS-PC')
            this.thresh_path = 'W:\\backtester4\\datasets\\main\\tresholds.json';
        else if (os.platform() == 'win32' && this.comp_name == 'JAS-VPS')
            this.thresh_path = 'C:\\Users\\JAS\\Documents\\backtester_4\\datasets\\main\\tresholds.json';
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
            P.minQty = info.filters.find(obj => obj.filterType == 'LOT_SIZE').minQty;
            P.minNotional = parseFloat(info.filters.find(obj => obj.filterType == 'MIN_NOTIONAL').minNotional);
            P.ticksize = parseFloat(PRICE_FILTERS.tickSize);
            P.precision = PRICE_FILTERS.tickSize.split('.')[1].split('1')[0].length + 1 || 0;
            P.round = 10 ** P.precision;
        }

        if (this.log_level >= 3)
            print('system', 'New exchange infos queried')
    }

    /**
     * Set initial pairs balance via rest, set BTC balances in Session
     * Only for traded pairs and BTC
     *
     * decrement error count each fetchs, quit program if more than 3 errors in a a short time
     *
     *
     * @return {Promise<void>}
     */
    async initBalances() {
        await new Promise(async (resolve, reject) => {
            let balances = {};

            try {
                balances = await getBalances();
                if (this.error_count >= 0) this.error_count--;
            } catch (e) {
                if (e.body && typeof e.body == 'string' && JSON.parse(e.body).code == -1021)
                    print('system', 'Timestamp for this request was 1000ms ahead of the server time.');
                if (this.error_count > 3) {
                    // Cancel all buy orders
                    print(pair, '4 errors in a short time, canceling buy orders and stopping.');
                    await Promise.all(this.pairs.map(async pair => {
                        const Pair = this.Pairs[pair];
                        Pair.stopped = true;
                        if (Pair.order_id) Pair.cancel_buy();
                    }));
                    await this.sellAll();
                    process.exit(1);
                }
                this.error_count++;
            }

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
    isConcurrentCountBusted() {
        let count = 0;
        for (const p in this.Pairs) {
            if (this.Pairs[p].isConcurrent) count++;
        }
        return count >= this.options.concurent_count_max;
    }

    /** Re-start "stopped" pair that are due to trade again
     *
     *  conditions:
     *      - stopped
     *      - stopped until reached < now
     *
     * Or
     *
     *  (No buy order because buy failed for any reasons)
     *  conditions:
     *      - no buy order
     *      - not selling
     *      - not busy
     *      - concurent count not reached
     *
     * @return {Promise<void>}
     */
    async handleStoppedForAnyReason() {
        const now = Date.now();
        await Promise.all(this.pairs.map(async pair => {
            const Pair = this.Pairs[pair];
            Pair.setMinNotionalState();
            if (Pair.stopped && now > Pair.stopped_until) {
                print(pair, 'Re-starting stopped pair...');
                Pair.stopped = false;
                delete Pair.stopped_until;
                await Pair.handle_place_buy();
            } else if (
                !Pair.stopped
                && !Pair.busy
                && !Pair.order_id
                && !Pair.sell_placed
                && !this.isConcurrentCountBusted()
                && Pair.position_size_is_over_minNotional
                && !Pair.is_handling_place_buy
            ) {
                print(pair, 'Re-trying buy for stagnant pair...');
                await Pair.handle_place_buy();
            }
        }));
    }

    /** Check balances to detect fills
     *
     * @return {Promise<void>}
     */
    async handleBalanceChanges() {
        await this.initBalances();
        this.pairs.map(pair => {
            const Pair = this.Pairs[pair];
            const totalBalance = Pair.getTotalBalance();
            const balanceIsUp = Pair.balance_available * Pair.sell_line >= Pair.minNotional;
            const balanceIsDown = (Pair.totalBalanceLastKnown - totalBalance) * Pair.buy_line >= Pair.minNotional;

            if (!Pair.stopped && !Pair.busy && balanceIsUp) {
                Pair.handleHigherBalance();
            } else if (!Pair.stopped && !Pair.busy && balanceIsDown) {
                Pair.handleLowerBalance();
            }
        });
    }

    /** Place sell order for pairs that have unassessed balances.
     *
     * Unassessed coin balances to sell are hard to avoid, either this or constant place_buy_order spam...
     *
     * @return {Promise<void>}
     */
    async handleUnassessedBalances() {
        await this.initBalances();
        await Promise.all(this.pairs.map(async pair => {
            const Pair = this.Pairs[pair];
            Pair.setMinNotionalState();
            const hasQuantity = Pair.balance_available * Pair.sell_line >= Pair.minNotional * 1.1;
            if (!Pair.stopped
                && !Pair.busy
                && !Pair.sell_order_id
                && hasQuantity
                && !Pair.is_handling_place_sell
            ) {
                print(pair, '!!!Re-trying sell for unassessed coin balance...');
                await Pair.handle_place_sell();
            }
        }));
    }

    /** Re-place buy order for pairs whom buy was canceled because the concurrent count max was reached.
     *
     * Conditions:
     *      - max conc count NOT busted
     *      - Pair is stopped for concurrent count
     *      - stopped_for_concurrent prop is true (set it to false if proceeding)
     *      - no order ID prop
     *      - buy_placed prop is false
     *
     * @return {Promise<void>}
     */
    async handleStoppedForConcurrent() {
        if (this.isConcurrentCountBusted()) return;
        await Promise.all(this.pairs.map(async pair => {
            const Pair = this.Pairs[pair];
            if (Pair.stopped_for_concurrent && !Pair.order_id && !Pair.buy_placed) {
                if (this.log_level >= 2)
                    print(pair, 'Concurrent count diminished, buying again');
                await Pair.handle_place_buy();
                Pair.stopped_for_concurrent = false;
            }
        }));
    }

    /** Check if buy orders should be canceled because of concurent count.
     *
     * Conditions:
     *      - is NOT stopped for concurrent count
     *      - max conc count reached
     *      - stopped_for_concurrent prop is true (set it to true)
     *      - has either order_id or buy_placed
     *
     * @return {Promise<void>}
     */
    async handleConcurentCount() {
        if (!this.isConcurrentCountBusted()) return;
        await Promise.all(this.pairs.map(async pair => {
            const Pair = this.Pairs[pair];
            if (!Pair.stopped_for_concurrent && (Pair.order_id || Pair.buy_placed)) {
                if (this.log_level >= 2)
                    print(pair, 'Concurrent count reached and pair have orders, canceling');
                // Fetch all buy orders
                const orders = await Pair.get_orders();
                const buyOrders = orders.filter(order => order.side == 'BUY' && order.symbol == pair);
                // Cancel all buy orders
                await Pair.cancel_all_orders(buyOrders, 'buy');
                Pair.stopped_for_concurrent = true;
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
        await new Promise((resolve, reject) => {

            let ls = undefined;
            if (os.platform() === 'win32' && this.comp_name == 'JAS-PC') {
                ls = spawn('python', ['mod_control.py'], {cwd: 'W:\\fetch_klines'});
            } else if (this.comp_name == 'JAS-VPS' && this.comp_name == 'JAS-VPS') {
                ls = spawn('python', ['mod_control.py'], {cwd: 'C:\\Users\\JAS\\Documents\\fetch_klines'});
            } else {
                ls = spawn('python', ['mod_control.py'], {cwd: '/home/jasmin/fetch_klines'});
            }

            if (this.log_level >= 2)
                print('PY_1', 'Writing klines...');

            ls.stdout.on('data', msg => { // Number of new klines and symbol infos printed
                print('PY_1', msg);
            });

            ls.stderr.on('data', data => {
                if (typeof data == 'object') print('PY_1', Object.keys(data)); // means corrupted klines
                else print(typeof data);
                print('PY_1', 'Err during python 1 klines fetching (REST)', data.toString());
            });

            ls.on('close', code => {

                if (this.log_level >= 3 || code !== 0)
                    print('PY_1', `Python 1 process exited with code ${code}`);

                // Exit if fail on very first klines fetch err or second in a row
                if (!this.runned_once && code !== 0) {
                    print('system', `Exiting since first run and no treshold fallback.`);
                    process.exit(1);
                }
                this.runned_once = true;

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
        }

        if (this.log_level >= 3) {
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
        await new Promise((resolve, reject) => {
            let ls = undefined;
            if (os.platform() === 'win32' && this.comp_name == 'JAS-PC') {
                ls = spawn('python', ['mod_control.py', '--server'], {cwd: 'W:\\backtester4\\sample'});
            } else if (this.comp_name == 'JAS-VPS' && this.comp_name == 'JAS-VPS') {
                ls = spawn('python', ['mod_control.py', '--server'], {cwd: 'C:\\Users\\JAS\\Documents\\backtester_4\\sample'});
            } else {
                // pair must be listed in [pairstotest] from the python mod_data script
                ls = spawn('python', ['mod_control.py', '--server'], {cwd: '/home/jasmin/backtester4'});
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
                if (this.log_level >= 3 || code !== 0)
                    print('PY_2', `Python 2 process exited with code ${code}`);
                if (code !== 0) reject();
                this.parseDF(); // Parse DFs
                resolve();
            });
        });
    }


    balanceUpdate(data, S) {
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
        try {  // will simply print execution update names for wich not methods exists
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
            Pair.totalBalanceLastKnown = Pair.getTotalBalance();
            await this.limiter.limit('place_buy_order', Pair);
        }
    }

    /** Check if prices of current orders are deviating and place new ones after cancelin old ones.
     *
     * @return {Promise<void>}
     */
    async handle_new_prices() {
        await Promise.all(this.pairs.map(async pair => await this.Pairs[pair].handle_new_prices()));
    }

    getDelay() {
        return this.delay;
    }

    incDelay(ms) {
        this.delay += ms;
    }

    /** Sell all balances using market orders, only called by running the mod_sell_all script
     *
     * @return {Promise<void>}
     */
    async sellAll() {
        this.parseDF();
        await Promise.all(this.pairs.map(async pair => {
            const Pair = this.Pairs[pair];
            this.incDelay(150);
            setTimeout(async () => {
                await Pair.tryMarketSell();
            }, this.getDelay());
        }));
    }
}

module.exports = Session;