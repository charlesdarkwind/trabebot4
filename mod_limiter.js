const {print} = require('./mod_helpers');

class Limiter {
    constructor() {
        this.token_count = 10;
        this.queue = [];
        this.refillInterval();
        this.checkQueueInterval();

        // this.t(); // tests
    }

    // t() {
    //     setInterval(() => {
    //         const inQueue = this.queue.map(obj => obj.Pair.pair);
    //         if (inQueue.length > 0) console.log('test: ', inQueue);
    //     }, 3000);
    // }

    /**
     * If queue contains same Pair and side order, return the obj.
     *
     * @param Pair
     * @param fn
     * @return {object}
     */
    getInfo(Pair, fn) {
        return this.queue.find(obj => obj.Pair == Pair && obj.fn == fn);
    }

    async runQueue() {
        if (this.queue.length > 0) {
            for (let i = this.token_count; i > 0; i--) {
                const obj = this.queue[i - 1];
                this.token_count--;
                await obj.Pair[obj.fn](obj.args);
                if (i === 1) this.queue = this.queue.slice(this.token_count); // Loop ended
            }
        }
    }

    /**
     * refill bucket
     */
    refillBucket() {
        if (this.token_count < 10) this.token_count++;
    }

    /**
     * refill bucket interval
     */
    refillInterval() {
        setInterval(this.refillBucket.bind(this), 105);
    }

    /**
     * re-run queue interval
     */
    checkQueueInterval() {
        setInterval(async () => await this.runQueue.bind(this), 20);
    }

    /** Limit an order
     *
     * 1. if no token:
     *      push/unshift onto queue an obj with the function name, Pair context and other args
     * 2. else:
     *      exec now
     *
     * @param method - str - eg 'unshift'
     * @param fn - str - eg 'place_buy_order'
     * @param Pair - obj - Pair object instance
     * @param args - obj
     */
    async limit(method, fn, Pair, ...args) {
        return new Promise(async (resolve, reject) => {
            // has token: execute now
            if (this.token_count > 0) {
                this.token_count--;
                await Pair[fn](args);
            } else {
                // place in queue
                print(Pair.pair, `Limiting...`);
                this.queue[method]({fn, Pair, args});
            }
            resolve();
        });

    }
}

module.exports = Limiter;