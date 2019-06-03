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

/** Generate average of mean deviations
 *
 * @param charts {Object}
 * @param pairs {Array}
 * @param options {Object}
 * @param fastMode {Boolean} - use last kline
 */
exports.generateMads = (charts, pairs, options, fastMode) => {
    const {base_dev_lo_mult, base_dev_hi_mult, mad_window} = options;
    const mads = {};

    const generateMad = pair => {
        const highMads = [], lowMads = [], close = charts[pair].close;
        const len = fastMode ? close.length : close.length - 1;

        for (let i = len - mad_window; i < len; i++) {
            // rolling mean close, array
            let sum = 0;
            for (let j = i - mad_window; j < i; j++) sum += close[j];
            const mean = sum / mad_window;

            // Push into arrays of mads, eg: [ low[i] / meanClose[i], ...n ]
            const lowMad = Math.abs(charts[pair].low[i] / mean - 1);
            const highMad = Math.abs(charts[pair].high[i] / mean - 1);
            lowMads.push(lowMad);
            highMads.push(highMad);
        }

        // mean of low mads, scalar
        let loSum = 0;
        let loLen = lowMads.length;
        for (let i = 0; i < loLen; i++) loSum += lowMads[i];
        const loMad = Math.sqrt(1 - loSum / loLen) * base_dev_lo_mult;

        // mean of high mads, scalar
        let hiSum = 0;
        let hiLen = highMads.length;
        for (let i = 0; i < hiLen; i++) hiSum += highMads[i];
        const hiMad = Math.sqrt(1 + hiSum / hiLen) * base_dev_hi_mult;

        return {loMad, hiMad}
    };

    for (let i = 0; i < pairs.length; i++) {
        mads[pairs[i]] = generateMad(pairs[i]);
    }

    return mads;
};

/** Generate average of given length, eg 20
 *
 * @param charts {Object}
 * @param pairs {Array}
 * @param options {Object}
 * @param fastMode {Boolean} - use last kline
 */
exports.generateSmaBaseSells = (charts, pairs, options, fastMode) => {
    const {sma_base_sell} = options;
    const baseSells = {};

    for (let i = 0; i < pairs.length; i++) {
        const close = charts[pairs[i]].close;
        const len = fastMode ? close.length : close.length - 1;
        let sum = 0;
        for (let i = len - sma_base_sell; i < len; i++) sum += close[i];
        baseSells[pairs[i]] = sum / sma_base_sell;
    }

    return baseSells;
};

/** Generate average minus 1 stdev for given length
 *
 * @param charts {Object}
 * @param pairs {Array}
 * @param options {Object}
 * @param baseSells {Object} - Object containaing averages for each pairs (scalars)
 * @param fastMode {Boolean} - use last kline
 */
exports.generateMedians = (charts, pairs, options, baseSells, fastMode) => {
    const {sma_base_sell, sma_median} = options;
    const stdevs = {};
    const medians = {};

    // Since both are the same, no need to recalc another average
    // noinspection JSValidateTypes
    if (sma_base_sell != sma_median) {
        console.error('Different sizes of sma_sell and sma_median not implemented');
        process.exit(1);
    }

    for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i];
        const close = charts[pair].close;
        const len = fastMode ? close.length : close.length - 1;
        const mean = baseSells[pair];

        // sum of squared errors
        let sum = 0;
        for (let i = len - sma_median; i < len; i++) {
            sum += (close[i] - mean) ** 2;
        }

        const stdev = Math.sqrt(sum / (sma_median - 1));
        medians[pair] = mean - stdev;
    }

    return medians;
};

/** Generate slope of each pairs and slope of the whole market for each pairs
 *
 * @param charts {Object}
 * @param pairs {Array}
 * @param options {Object}
 * @param fastMode {Boolean} - use last kline
 * @return global_slopes {Object} - Object of global slopes
 */
exports.generateSlopes = (charts, pairs, options, fastMode) => {
    const {sma_slope_pair} = options;
    const pair_slopes = {};
    const gobal_slopes = {};
    const pairsLen = pairs.length;

    for (let i = 0; i < pairsLen; i++) {
        const pair = pairs[i];
        const close = charts[pair].close;
        const len = fastMode ? close.length : close.length - 1;

        // Short ma
        const sma2 = (close[len-1] + close[len-2]) / 2;

        // long ma
        let sum = 0;
        for (let j = len - sma_slope_pair; j < len; j++) {
            sum += close[j];
        }
        const sma20 = sum / sma_slope_pair;

        // slope of the pair
        pair_slopes[pair] = sma2 / sma20;
    }

    // squared global slope
    for (let i = 0; i < pairsLen; i++) {
        const pair = pairs[i];
        let sum = 0;

        for (let j = 0; j < pairsLen; j++) {
            const otherPair = pairs[j];
            if (pair == otherPair) continue;
            sum += pair_slopes[otherPair];
        }
        gobal_slopes[pair] = (sum / (pairsLen -1)) ** 2;
    }

    return gobal_slopes;
};