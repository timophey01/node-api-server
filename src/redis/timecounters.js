const _ = require('lodash');

const PARALLEL_KEYS_ROLLUP = 10;

class TimeCounters {
    constructor(redis, prefix, options = {}) {
        this.redisInstance = redis;
        this.prefix = prefix;
        this.isIncrementFirst = !(options.isIncrementFirst === false);
        this.rollupPeriods = options.rollupPeriods || {
            ignore: 60,
            rollup: [
                {
                    period: 60,
                    lt: 60 * 60
                },
                {
                    period: 60 * 60,
                    lt: 24 * 60 * 60
                }
            ]
        };
        this.expireKeyTime = options.expireKeyTime
            || Math.max(...this.rollupPeriods.rollup.map(({ lt }) => lt));
        this.getNow = options.getNow || (() => parseInt(Date.now() / 1000, 10));
        this.limits = options.limits || {
            60: 100,
            3600: 1000
        };
        this.parallelKeyRollupChunkSize = options.parallelKeyRollupChunkSize || PARALLEL_KEYS_ROLLUP;
        this.rollupOnIncrement = options.rollupOnIncrement !== false;
        this.options = options;
    }

    getCounterKey(key) {
        return `${this.prefix}:counters:${key}`;
    }

    async incrementKey(key, time, count = 1) {
        return Promise.all([
            this.redisInstance.hincrbyAsync(key, time, count),
            this.redisInstance.expireAsync(key, this.expireKeyTime)
        ]);
    }

    async check(redisCounterKey, overflowConst = 0) {
        const now = this.getNow();
        const counters = (await this.redisInstance.hgetallAsync(redisCounterKey)) || {};
        return Math.max(...Object.entries(this.limits).map(([interval, limit]) => {
            const countersForInterval = Object.entries(counters)
                .filter(([time]) => now - time < interval);
            if (countersForInterval.reduce((res, [, count]) => res - count, limit) < overflowConst) {
                return Math.min(...countersForInterval.map(([time]) => interval - (now - time)));
            }
            return 0;
        }));
    }

    /**
     *
     * @param key
     * @returns {Promise<number>}
     */
    async checkAndIncrement(key) {
        const now = this.getNow();
        await this._rollupKey(key);
        const redisCounterKey = this.getCounterKey(key);
        let overflowConst = 1;
        if (this.isIncrementFirst) {
            overflowConst = 0;
            await this.incrementKey(redisCounterKey, now);
        }
        const delay = await this.check(redisCounterKey, overflowConst);

        if (delay && this.isIncrementFirst) {
            await this.incrementKey(redisCounterKey, now, -1);
        }
        if (!this.isIncrementFirst) {
            await this.incrementKey(redisCounterKey, now);
        }
        return delay;
    }

    async getCounters(key) {
        const now = this.getNow();
        const redisCountKey = this.getCounterKey(key);
        const counters = await this.redisInstance.hgetallAsync(redisCountKey);
        return _(counters)
            .toPairs()
            .reduce((results, [time, count]) => _.mapValues((limit, period) => {
                if (now - time < period) {
                    return limit - count;
                }
                return limit;
            }), _.clone(this.limits))
            .value();
    }

    /**
     * Potential time counters can be negative but it should be work anyway.
     * @param key
     */
    async decrementLast(key) {
        return this.incrementKey(this.getCounterKey(key), this.getNow(), -1);
    }


    async rollup(keys = []) {
        const keysChunks = _.chunk(keys, this.parallelKeyRollupChunkSize);
        for (const chunk of keysChunks) { // eslint-disable-line no-restricted-syntax
            await Promise.all(chunk.map(key => this._rollupKey(key))); // eslint-disable-line no-await-in-loop
        }
    }

    async _rollupKey(key) {
        const now = this.getNow();
        const redisCountKey = this.getCounterKey(key);
        const counters = await this.redisInstance.hgetallAsync(redisCountKey);
        const groupedCounter = _(counters)
            .toPairs()
            .groupBy(([time]) => {
                if (now - time < this.rollupPeriods.ignore) {
                    return 'ignore';
                }
                for (const { lt, period } of this.rollupPeriods.rollup) { // eslint-disable-line no-restricted-syntax
                    if (now - time < lt) {
                        return parseInt(time / period, 10) * period;
                    }
                }
                return 'delete';
            })
            .value();
        delete groupedCounter.ignore;
        let toDelete = _(groupedCounter)
            .mapValues(v => v.map(([val]) => val))
            .values()
            .flatten()
            .value();

        delete groupedCounter.delete;
        const toSet = _(groupedCounter)
            .mapValues(v => v.map(([, elem]) => elem).reduce((sum, val) => sum + parseInt(val, 10), 0))
            .value();

        toDelete = toDelete.filter(v => toSet[v] !== Number(counters[v]));

        const redisMulti = this.redisInstance.multi();
        if (toDelete.length) {
            toDelete.forEach(toDel => redisMulti.hdel(redisCountKey, toDel));
        }
        if (Object.keys(toSet).length) {
            redisMulti.hmset(redisCountKey, ..._(toSet).toPairs().flatten().values());
        }
        if (Object.keys(toSet).length || toDelete.length) {
            return new Promise((resolve, reject) => {
                redisMulti.exec((err) => {
                    if (err) {
                        return reject(err);
                    }
                    return resolve({
                        toSet,
                        toDelete,
                    });
                });
            });
        }
        return Promise.resolve({});
    }
}

module.exports = { TimeCounters };
