"use strict";
if (!global.Promise || !global.Promise.promisify) {
    // Use promisify as a proxy for 'has modern promise implementation'
    // Bluebird is faster than native promises in node 0.10 & 0.11, so
    // normally use that.
    global.Promise = require('bluebird');
}

// many concurrent connections to the same host
var Agent = require('./http_agent.js').Agent,
	httpAgent = new Agent({
		connectTimeout: 5 * 1000,
		maxSockets: Infinity
	});
require('http').globalAgent = httpAgent;

var util = require('util');
var req = require('request');

function getOptions(uri, o, method) {
    if (!o || o.constructor !== Object) {
        if (uri) {
            if (typeof uri === 'object') {
                o = uri;
            } else {
                o = { uri: uri };
            }
        } else {
            throw new Error('preq options missing!');
        }
    } else {
        o.uri = uri;
    }
    o.method = method;
    if (o.body && o.body instanceof Object) {
        if (o.headers && /^application\/json/.test(o.headers['content-type'])) {
            o.body = JSON.stringify(o.body);
        } else if (o.method === 'post') {
            o.form = o.body;
            o.body = undefined;
        }
    }

    if ((o.method === 'get' || o.method === 'put')
            && o.retries === undefined) {
        // Idempotent methods: Retry by default
        o.retries = 5;
    }


    // Set a timeout by default
    if (o.timeout === undefined) {
        o.timeout = 1 * 60 * 1000; // 1 minute
    }

    // Default pool options: Don't limit the number of sockets
    if (!o.pool) {
        o.pool = {maxSockets: Infinity};
    }
    return o;
}

/*
 * Error instance wrapping HTTP error responses
 *
 * Has the same properties as the original response.
 */
function HTTPError(response) {
    Error.call(this);
    Error.captureStackTrace(this, HTTPError);
    this.name = this.constructor.name;
    this.message = JSON.stringify(response);

    for (var key in response) {
        this[key] = response[key];
    }
}
util.inherits(HTTPError, Error);

function wrap(method) {
    return function (url, options) {
        options = getOptions(url, options, method);
        return new Promise(function(resolve, reject) {
            var retries = options.retries;
            var timeout = options.timeout;
            var delay = 50;
            var cb = function(err, res) {
                if (err || !res) {
                    if (retries) {
                        //console.log('retrying', options, retries, delay);
                        setTimeout(req.bind(req, options, cb), delay);
                        retries--;
                        delay *= 2;
                        options.timeout = timeout + delay;
                        return;
                    }
                    if (!err) {
                        err = new HTTPError({
                            status: 500,
                            body: {
                                type: 'empty_response',
                            }
                        });
                    } else {
                        err =  new HTTPError({
                            status: 500,
                            body: {
                                type: 'internal_error',
                                description: err.toString(),
                                error: err
                            },
                            stack: err.stack
                        });
                    }
                    return reject(err);
                }

                if (res.body && res.headers &&
                        /^application\/json/.test(res.headers['content-type'])) {
                    res.body = JSON.parse(res.body);
                }

                var ourRes = {
                    status: res.statusCode,
                    headers: res.headers,
                    body: res.body
                };

                if (ourRes.status >= 400) {
                    reject(new HTTPError(ourRes));
                } else {
                    resolve(ourRes);
                }
            };

            req(options, cb);
        });
    };
}

var preq = function preq (url, options) {
    var method = (options || url || {}).method || 'get';
    return preq[method](url, options);
};

var methods = ['get','head','put','post','delete','trace','options','mkcol','patch'];
methods.forEach(function(method) {
    preq[method] = wrap(method);
});

module.exports = preq;
