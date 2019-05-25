const {print} = require('./mod_helpers');

class Limiter {
    constructor() {
        this.token_count = 10;
        this.queue = [];
    }

    setTokenCount(count) {
        this.token_count += count;
    }

    getTokenCount() {
        return this.token_count;
    }

    getQueue() {
        return this.queue;
    }

    pushInQueue(obj) {
        this.queue.push(obj);
    }

    getFirstInQueue() {
        return this.queue.shift();
    }

    /**
     * If queue contains same Pair and side order, return the obj.
     *
     * @param Pair
     * @param fn
     * @return {object}
     */
    getInfo(Pair, fn) {
        return this.getQueue().find(obj => obj.Pair.pair == Pair.pair && obj.fn == fn);
    }

    runQueue() {
        if (!this.getQueue().length) return;
        for (let i = 0; i < this.getTokenCount(); i++) {
            const obj = this.getFirstInQueue();
            obj.Pair[obj.fn]();
            this.setTokenCount(-1);
        }
    }

    /** Limit an order
     *
     * 1. if no token:
     *      push/unshift onto queue an obj with the function name, Pair context and other args
     * 2. else:
     *      exec now
     *
     * @param fn - str - eg 'place_buy_order'
     * @param Pair - obj - Pair object instance
     */
    async limit(fn, Pair) {
        return new Promise(async (resolve, reject) => {
            // has token: execute now
            if (this.getTokenCount() > 0) {
                this.setTokenCount(-1);
                await Pair[fn]();
            } else {
                // place in queue
                print(Pair.pair, 'Limiting...');
                this.pushInQueue({fn, Pair});
            }
            resolve();
        });
    }
}

module.exports = Limiter;