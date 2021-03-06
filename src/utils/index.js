const { fromPairs } = require('lodash');

async function delayer(delay) {
    return new Promise((resolve) => {
        setTimeout(resolve, delay);
    });
}

const metricMethodList = [
    'findOne',
    'upsert',
    'update',
    'updateOne',
    'insertOne',
    'insertMany',
    'findAndModify',
    'find',
    'aggregate',
    'count',
    'upsertMany'
];

const logMethodList = {
    findOne: 'debug',
    upsert: 'debug',
    update: 'debug',
    updateOne: 'debug',
    aggregate: 'debug',
    count: 'debug',
    insertOne: 'debug',
    find: 'debug',
    upsertMany: 'debug',
    findAndModify: 'debug'
};

function uriToMetricPath(uri) {
    return uri
        .toLowerCase()
        .replace(/\//gim, '_')
        .replace(/[^a-z0-9_]/gim, '');
}

function camelCaseToKebab(str) {
    return str.replace(/([a-z])([A-Z])/g, '$1-$2')
        .replace(/\s+/g, '-')
        .toLowerCase();
}

function inurlParams(inurlPath = 'inurl') {
    return (req) => {
        req.body = { ...req.body, [inurlPath]: req.params };
    };
}

function inqueryParams(inqueryPath = 'inquery') {
    return (req) => {
        req.body = { ...req.body, [inqueryPath]: req.query || {} };
    };
}

// TODO redirect ip add here
function ipToParams(ipPath = 'ip') {
    return (req) => {
        req.body = { ...req.body, [ipPath]: req.ip };
    };
}

function headerToParams(headersPath = 'headers', headerList = []) {
    return (req) => {
        req.body = {
            ...req.body,
            [headersPath]: fromPairs(headerList.map(headerName => [headerName, req.header(headerName)]))
        };
    };
}

function getMetricPathREST(prefix) {
    return (req, res) => `${prefix}.${req.method.toLowerCase()}.${uriToMetricPath(res.locals.path || req.url)}`;
}

module.exports = {
    delayer,
    getMetricPathREST,
    inurlParams,
    headerToParams,
    ipToParams,
    inqueryParams,
    camelCaseToKebab,
    metricMethodList,
    logMethodList
};
