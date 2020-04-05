let appConfig = {},
    redisClient = null;

const  redis = require('redis'),
    bluebird = require('bluebird'),
    Boom = require('boom'),
    app_config = require('application-configuration')(),
    app_config_settings = app_config.settings,
    app_config_constants = app_config.constants,
    logging = require('logging')(),
    generalLogger = logging.general,
    logTypes = logging.logTypes;


function error(redisErr) {
    var err = {
      statusCode: constants.ERROR.ERROR_CODE,
      code: constants.ERROR.STATUS_CODE,
      message: constants.ERROR.MESSAGE
    };

    return err;
}

class keyNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'keyNotFoundError';
  }
}

// Connects to Redis and creates Redis client
function getRedisClient() {
  if (redisClient === null) {
    bluebird.promisifyAll(redis.RedisClient.prototype);
    redisClient = redis.createClient(
          process.env.REDIS_INSTANCE_PORT || appConfig.settings.get('/REDIS_INSTANCE_PORT'),
          process.env.REDIS_INSTANCE_HOST || appConfig.settings.get('/REDIS_INSTANCE_HOST'), {
          retry_strategy: function (options) {
            if (options.error.code === 'ECONNREFUSED') {
              // End reconnecting on a specific error and flush all commands with a individual error
              console.log('The Redis server is down');
              return Boom.create(503, "The Redis server is down", app_config_constants.get('/NODE_CODES/CACHING_DOWN'));
            }
            if (options.total_retry_time > 1000 * 60 * 60) {
              // End reconnecting after a specific timeout and flush all commands with a individual error
              console.log('Retry time exhausted');
              return Boom.create(503, "The Redis server is down", app_config_constants.get('/NODE_CODES/CACHING_DOWN'));
            }
            if (options.times_connected > 100) {
              // End reconnecting with built in error
              console.log('Maximum number of retries has been reached');
              return Boom.create(503, "The Redis server is down", app_config_constants.get('/NODE_CODES/CACHING_DOWN'));
            }
            // reconnect after
            console.log('Reconnect after: ' + Math.max(options.attempt * 100, 30000).toString());
            return Math.max(options.attempt * 100, 30000);
          }
        }
    );

    redisClient.on("error", function (err) {
      console.log("Error " + err);
      generalLogger.log.error(logTypes.fnExit({
        err:err
      }), `redisClient error`);
    });

    redisClient.on("connect", function (err) {
      console.log("Connected to Redis server");
    });

    redisClient.on("reconnecting", function (err) {
      console.log("Attempting to reconnect to Redis server");
    });

    console.log('Redis Client Created: ' + redisClient.address);
  }

  return redisClient;
}
const cacheWrite = function cacheWrite(key, field, data) {
  const client = getRedisClient();
  let extendExpiry = false; //boolean
  return client.existsAsync(key)
    .then(function(res) {
      extendExpiry = (res === 0);// the key does not exist, so expire for 60min only
      return client.hsetAsync(key, field, JSON.stringify(data))
    })
    .then(function(res) {
      generalLogger.log.info(logTypes.fnInside({
        clientId:key,
        field: field,
        data: JSON.stringify(data)
      }), `cacheWrite success!`);
      const expireTime = field == 'Count' ? 60 * 30 : app_config_settings.get('/JWT/CACHE/USER_KEYS/EXPIRE_TIME') * 60;
      // expire the key to only 60m due to client requirement
      if (extendExpiry) {
        return client.expireAsync(key, expireTime);
      } else {
        return Promise.resolve();
      }
    })
    .catch(function(err) {
      generalLogger.log.error(logTypes.fnExit({
        key:key,
        field:field,
        data: JSON.stringify(data)
      }), `Unable to cacheWrite`);
    });
}

const cacheMultiWrite = function cacheMultiWrite(key, dataArray, expiresIn ) {
  const client = getRedisClient();
  return client.hmsetAsync(key, dataArray)
    .then(function(res) {
      generalLogger.log.info(logTypes.fnInside({
        key:key,
        data: JSON.stringify(dataArray),
        expires: `${expiresIn} min`
      }), `cacheMultiWrite success!`);
    
      return client.expireAsync(key, expiresIn * 60);
    })
    .catch(function(err) {
      generalLogger.log.error(logTypes.fnExit({
        key:key,
        data: JSON.stringify(dataArray)
      }), `Unable to cacheMultiWrite`);
    });
}

const cacheEsbResult = function cacheEsbResult (key, field, data) {
  return new Promise(function(resolve, reject) {
    const client = getRedisClient();
    client.exists(key, function(err,res) {

      if (err) reject(err);
      if (res) {
        //key exists
        client.hset(key, field, JSON.stringify(data), function(err, res) {
          if (err) reject(err);
          resolve();
        })
      } else {
        generalLogger.log.debug(logTypes.fnInside({sec02token:key}), `JWT Was not found`);
        reject();
      }
    })
  });
};

const fetchEsbResult = function fetchEsbResult(key, field) {
  return new Promise(function(resolve, reject) {
    const client = getRedisClient();
    client.hget(key, field, function(err, res) {
      if (err) {
        generalLogger.log.debug(logTypes.fnInside({sec02token:key, field: field}), `unable to fetch - redis error`);
        reject(err);
      } else {
        if (res) {
          // cachehit
          generalLogger.log.info(logTypes.fnInside({sec02token:key, field: field}), `CACHEHIT: key and field were found: ${res}`);
          resolve(JSON.parse(res));
        } else {
          // cachemiss
          generalLogger.log.info(logTypes.fnInside({sec02token:key, field: field}), `CACHEMISS: key and/or field was not found`);
          reject(new keyNotFoundError(`${key} not found`));
        }
      }
    })
  });
};

const fetchObjects = function fetchObjects(key) {
  return new Promise(function(resolve, reject) {
    const client = getRedisClient();
    client.hgetall(key, function(error, result) {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    })
  });
}

const deleteKey = function deleteKey(key) {
  return new Promise(function(resolve, reject) {
    const client = getRedisClient();
    client.del(key, function(error, result) {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    })
  });
}

module.exports = function(config) {

  // Initialize opts in case it isn't passed in
  config = config || {};

  // Get default data from files, otherwise initialize empty objects
  var settings = {};
  var constants =  {};

  // If opts contains a setting property, then merge that setting property with the default settings
  // This allows us to override the default settings with our own settings. The merge deals with conflicts by using the values from opts.
  if(config.hasOwnProperty('settings')) {
    Object.assign(settings, config.settings);
  }

  // This works exactly the same way as settings
  if(config.hasOwnProperty('constants')) {
    Object.assign(constants, config.constants);
  }

  config.settings = settings;
  config.constants = constants;

  appConfig = require('application-configuration')(config);

  return {
    getRedisClient: getRedisClient,
    cacheEsbResult: cacheEsbResult,
    fetchEsbResult: fetchEsbResult,
    cacheWrite: cacheWrite,
    cacheMultiWrite: cacheMultiWrite,
    fetchObjects: fetchObjects,
    deleteKey: deleteKey
  };
}

 
