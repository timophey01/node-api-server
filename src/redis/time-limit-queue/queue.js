const { Queue } = require('../queue');
const { fromPairs } = require('lodash');

class DelayPeriod {
    constructor(delay) {
        this.delay = delay;
    }
}

const loggerStub = {
    debug: console.log, info: console.log, error: console.log, warn: console.log
};

const DROP_KEY_PREFIX = ''

const GLOBAL_COUNTERS_KEY = 'global';

class FailForce {}

class TimeLimitsQueue extends Queue {
    constructor(name, redis, options = {}, limits) {
        options.queueOptions = {
            ...(options.queueOptions || {}),
            settings: {
                backoffStrategies: {
                    delayable: (attemptsMade, err) => this.backoffDelayableStrategy(attemptsMade, err)
                }
            }
        };
        super(name, redis, options);
        this.realAttemptCount = options.attemptCount || 1;
        /**
         * @var TimeCounters
         */
        this.globalLimit = limits.global;
        /**
         * @var TimeCounters[]
         */
        this.perJobLimits = limits.perJob;

        this.logMessageCallback = () => {};
    }

    async add(job, opt) {
        const delay = await this.globalLimit.checkAndIncrement(GLOBAL_COUNTERS_KEY);
        if (delay) {
            if (this.logMessageCallback) {
                this.logMessageCallback({
                    isGlobalPause: true,
                    pauseInterval: delay
                });
            }
            await this.delayQueue(delay * 1000);
        }

        return super.add(job, {
            ...opt,
            attempts: 900001,
            backoff: {
                type: 'delayable'
            }
        });
    }

    async getCounterById(counterName, id) {
        const timeCounter = this.perJobLimits.filter(({ name }) => name === counterName)[0];
        if (!timeCounter) {
            return null;
        }
        return timeCounter.timeCounter.getCounters(id);
    }

    getLimits(counterName) {
        const timeCounter = this.perJobLimits.filter(({ name }) => name === counterName)[0];
        if (!timeCounter) {
            return null;
        }
        return timeCounter.timeCounter.getLimits();
    }

    async getAllCounters(job) {
        return Promise.all([
            this.globalLimit.getCounters(GLOBAL_COUNTERS_KEY),
            ...this.perJobLimits.map(async ({
                timeCounter, getIdFunc, name
            }) => {
                const id = getIdFunc(job);
                return {
                    name,
                    counters: await timeCounter.getCounters(id),
                    limits: timeCounter.getLimits(),
                    id
                };
            })
        ]).then(([global, ...perJobs]) => ({
            global,
            ...fromPairs(perJobs.map(counter => [counter.name, counter]))
        }));
    }

    async getMaxDelay(job) {
        const dropObj = (await Promise.all(this.perJobLimits.map(async (
            { timeCounter, getIdFunc }
        ) => {
            const id = getIdFunc(job);
            return timeCounter.checkBlock(id);
        }))).filter(({ isDrop }) => isDrop);
        if (dropObj.length) {
            return dropObj[0];
        }
        const delays = await Promise.all(this.perJobLimits.map(async (
            { timeCounter, getIdFunc, dropInterval, blockInterval }) => {
            const id = getIdFunc(job);
            const { delay, interval } = await timeCounter.checkWithFutureIncrements(id);
            return {
                delay,
                interval,
                id,
                timeCounter,
                dropInterval,
                blockInterval
            };
        }));
        const dropDelay = delays.filter(({ interval, dropInterval }) => interval >= dropInterval);
        const isDrop = Boolean(dropDelay.length);
        const maxDelay = Math.max(...[
            ...delays.map(({ delay }) => delay),
            ...dropDelay.map(({ blockInterval }) => blockInterval)
        ]);

        await Promise.all(dropDelay.map(({ timeCounter, id, blockInterval, dropInterval }) =>
            timeCounter.setBlock(id, blockInterval || dropInterval)));
        return { maxDelay, isDrop };
    }

    async incrementAfterDelay(job, delay) {
        return Promise.all(this.perJobLimits.map(async ({ timeCounter, getIdFunc }) => timeCounter.incrementKey(
            timeCounter.getCounterKey(getIdFunc(job)),
            timeCounter.getNow() + delay
        )));
    }

    setLogMessageCallback(callback) {
        if (typeof callback !== 'function') {
            throw Error('Callback type is not a function');
        }
        this.logMessageCallback = callback;
    }

    /**
     * @param job
     */
    processCallbackWrapper(callback, logger = loggerStub) {
        return async (job) => {
            if (job.attemptsMade === 0) {
                const { maxDelay, isDrop } = await this.getMaxDelay(job);
                job.data.counters = await this.getAllCounters(job);
                job.data.countersInfo = { maxDelay, isDrop };
                logger.debug('max delays for job', {
                    maxDelay, isDrop, jobData: job.data, name: this.name
                });
                if (this.logMessageCallback) {
                    this.logMessageCallback({
                        maxDelay, isDrop, jobData: job.data, name: this.name
                    });
                }
                if (isDrop) {
                    return Promise.reject(new FailForce());
                }
                this.incrementAfterDelay(job, maxDelay || 0);
                if (maxDelay) {
                    return Promise.reject(new DelayPeriod(maxDelay * 1000));
                }
            }
            const { maxDelay, isDrop } = await this.getMaxDelay(job);
            job.data.counters = await this.getAllCounters(job);
            job.data.countersInfo = { maxDelay, isDrop };
            return callback(job);
        };
    }

    setProcessCallback(callback, logger = loggerStub) {
        return super.setProcessCallback(this.processCallbackWrapper(callback, logger));
    }

    process(...args) {
        return super.process(...args);
    }

    backoffDelayableStrategy(attemptsMade, err) {
        if (err instanceof DelayPeriod) {
            return err.delay;
        }
        if (attemptsMade >= this.realAttemptCount || err instanceof FailForce) {
            return -1;
        }
        return 0;
    }
}

module.exports = { TimeLimitsQueue };
