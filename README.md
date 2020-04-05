## Synopsis

This is a custom cache library that wraps the node_redis module (https://github.com/NodeRedis/node_redis) which exposes a 'client' object you can use to interact with the Redis server.

Our custom wrapper exposes 'client' through the getRedisClient() function.

## Initialization

```javascript
var cache = require('cache')();
```

Note: the () after the require statement is mandatory.

The cache object exposes a function called getRedisClient() that is used to initiate commands with the Redis server.

```javascript
var cache = require('cache')(config);
```

## Usage
Redis HSET example:

```redis
HSET hash field value
```

```javascript
cache.getRedisClient().hset('hash', 'field', 'value', function(err, result) {
    // Callback for handling errors
});
```

Redis HGET example:

```redis
HGET hash field value
```

```javascript
cache.getRedisClient().hget('hash', 'field', function(err, result) {
    // Callback for handling the result
});
```
