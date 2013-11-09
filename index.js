'use strict';

var commandParser = require('./ircb/parser/command-parser')
  , replies = require('./ircb/parser/replies.json')
  , debug = require('debug')('ircb.io')
  , crypto = require('crypto')
  , async = require('async')
  , net = require('net')
  , tls = require('tls');

/**
 * Create a new IRC connection.
 *
 * Options:
 *
 *  host: The hostname.
 *  secure: secure connection.
 *  rejectUnauthorized: ignore ssl errors.
 *  port: The port number we should connect to.
 *  nick: The nickname.
 *  password: The nickname's password.
 *  user: The username.
 *  channels: The channels to join.
 *
 * @constructor
 * @param {Object} options The configuration
 * @param {Function} cb Optional callback.
 * @api public
 */
function IRCb(options, cb) {
  if (!(this instanceof IRCb)) return new IRCb(options, cb);
  options = options || {};

  //
  // Default to freenode, because.. Who doesn't use it?
  //
  if (!options.host) {
    options.host = 'irc.freenode.org';
    options.secure = true;
  }

  //
  // Add our default channel if the user is connecting to irc.freenode.net
  //
  if (!options.channels && options.host === 'irc.freenode.org') {
    options.channels = ['#ircb'];
  }

  this.secure = !!options.secure;
  this.rejectUnauthorized = !!options.rejectUnauthorized;
  this.port = +options.port || (this.secure ? 6697 : 6667);
  this.host = options.host;
  this.nick = options.nick;
  this.password = options.password;
  this.username = options.username;
  this.realName = options.realName;

  this._namesReplies = {};  // <names> replies.
  this.channels = [];       // current active channels.
  this.motd = '';           // The motd response.

  //
  // Establish a new connection.
  //
  var ircb = this;
  this.connection = (this.secure ? tls : net).connect({
    host: this.host,
    port: this.port,
    rejectUnauthorized: false
  }, function connected() {
    ircb.connection.on('data', function data(chunk) {
      ircb._onData(chunk);
    });

    ircb.emit('connect');

    async.series([
      function authenticate(next) {
        return ircb.password
          ? ircb.pass(ircb.password, next)
          : next();
      },
      function nickanme(next) {
        return ircb.nick
          ? ircb.nick_(ircb.nick, next)
          : next();
      },
      function username(next) {
        return (ircb.username && ircb.realName)
          ? ircb.user(ircb.username, ircb.realName, next)
          : next();
      },
      function join(next) {
        ircb.on('motd', function motd() {
          return options.channels
            ? ircb.join(options.channels, next)
            : next();
        });
      }
    ], function done() {
      ircb.emit('ready');
    });
  }).on('error', function error(err) {
    ircb.trigger('error', err);
  }).on('close', function close(errBool) {
    ircb.trigger('close', errBool);
  });

  //
  // Force UTF-8 encoding on the stream in order to prevent broken chunks of
  // messages that are cut right between the bytes.
  //
  this.connection.setEncoding('utf-8');
}

IRCb.prototype.__proto__ = require('eventemitter3').prototype;

/**
 * Emit a `event` as well as an extra `data` event for the received message.
 *
 * @param {String} event The name of the event we should trigger.
 * @api public
 */
IRCb.prototype.trigger = function trigger(event) {
  if (this.listeners(event).length) {
    this.emit.apply(this, arguments);
  }

  this.emit.apply(this, ['data'].concat(Array.prototype.slice.call(arguments, 0)));
  return this;
};

/**
 * We've received some incoming data chunk from the IRC server.
 *
 * @param {String} chunk The data.
 * @api private
 */
IRCb.prototype._onData = function (chunk) {
  chunk.split('\r\n').filter(Boolean)
    .forEach(this._parseMessage.bind(this));
};

/**
 * Parse the incoming message.
 *
 * @param {String} chunk The incoming message
 * @api private
 */
IRCb.prototype._parseMessage = function parse(chunk) {
  this._processMessage(commandParser(chunk));
};

/**
 * Process the actual message.
 *
 * @param {Object} message The parsed server response.
 * @api private
 */
IRCb.prototype._processMessage = function process(message) {
  var reply = replies[message.command],
      command = (reply && reply.name) || message.command,
      channel;

  switch (command) {
    case "001":
    case "NICK":
      this.nick = (command === "001") ? message.middle[0] : message.trailing;
      break;

    case "PING":
      this.write('PONG :' + message.trailing);
      break;

    case "JOIN":
      channel = message.middle[0];
      if (!channel) channel = message.trailing;

      this.trigger('join', message.prefix, channel);

      if (message.prefix.split('!')[0] === this.nick && this.channels.indexOf(channel) === -1) {
        this.channels.push(channel);
      }

      break;

    case "PART":
      channel = message.middle[0];
      this.trigger('part', message.prefix, channel, message.trailing);

      if (message.prefix.split('!')[0] === this.nick && this.channels.indexOf(channel) !== -1) {
        this.channels.splice(this.channels.indexOf(channel), 1);
      }

      break;

    case "KICK":
      channel = message.middle[0];
      this.trigger('kick', message.prefix, channel, message.middle[1], message.trailing);

      if (message.prefix.split('!')[0] === this.nick && this.channels.indexOf(channel) !== -1) {
        this.channels.splice(this.channels.indexOf(channel), 1);
      }

      break;

    // Handle MOTD
    case "RPL_MOTD":
      this.motd += message.trailing + '\n';
      break;

    case "RPL_ENDOFMOTD":
      this.trigger('motd', this.motd);
      break;

    case "ERR_NOMOTD":
      this.trigger('motd', null);
      break;

    case "PRIVMSG":
      var from = message.prefix.substr(0, message.prefix.indexOf('!'));
      this.trigger('message', from, message.middle[0], message.trailing);
      break;

    // Handle NAMES
    case "RPL_NAMREPLY":
      channel = message.middle[2];
      if (!this._namesReplies[channel]) {
        this._namesReplies[channel] = [];
      }

      Array.prototype.push.apply(this._namesReplies[channel], message.trailing.split(' ').filter(Boolean));
      break;

    case "RPL_ENDOFNAMES":
      channel = message.middle[1];

      if (this._namesReplies[channel]) {
        this.trigger('names', channel, this._namesReplies[channel]);
        delete this._namesReplies[channel];
      }

      break;

    default:
      if (command) this.trigger(command.toLowerCase(), message.middle[0], message.trailing);
      else debug('received an unknown command %s', JSON.stringify(message));
      break;
  }
};

/**
 * Write the nickname's password.
 *
 * @param {String} pass The password.
 * @param {Function} fn The callback.
 * @api private
 */
IRCb.prototype.pass = function (pass, cb) {
  this.write('PASS ' + pass, cb);
};

/**
 * Change the nickname of the user.
 *
 * @param {String} nick The new nickname.
 * @param {Function} cb The callback.
 * @api private.
 */
IRCb.prototype.nick_ = function (nick, cb) {
  this.write('NICK ' + nick, cb);
};

/**
 * Set the username of the current connection.
 *
 * @param {String} username The username.
 * @param {String} realName The realName.
 * @param {Function} cb The callback.
 * @api private
 */
IRCb.prototype.user = function (username, realName, cb) {
  this.write('USER ' + username + ' 0 * :' + realName, cb);
};

/**
 * Write a message.
 *
 * @param {String} target The receiver of the message.
 * @param {String} text The message.
 * @param {Function} cb The callback.
 * @api public
 */
IRCb.prototype.say = function say(target, text, cb) {
  this.write('PRIVMSG ' + target + ' :' + text, cb);
};

/**
 * Join a new channel, or join multiple channels at once.
 *
 * @param {String|Array} channels The channels to join.
 * @param {Function} cb The callback.
 * @api private
 */
IRCb.prototype.join = function join(channels, cb) {
  channels = Array.isArray(channels) ? channels : [ channels ];
  this.write('JOIN ' + channels.join(','), cb);
};

/**
 * Part or leave the given IRC channels.
 *
 * @param {String|Array} channels The channels to part from.
 * @param {String} message Optional message for leaving the channel.
 * @param {Function} fn The callback.
 * @api public
 */
IRCb.prototype.part = IRCb.prototype.leave = function part(channels, message, cb) {
  if (typeof message === 'function') {
    cb = message;
    message = '';
  }

  channels = Array.isArray(channels) ? channels : [ channels ];
  this.write('PART ' + channels.join(',') + ' :' + message, cb);
};

/**
 * Kick a user out of the channel.
 *
 * @param {String} channel The channel we should kick the user from
 * @param {String} nick The nickname we need to kick
 * @param {String} message Optional message.
 * @param {Function} cb The callback.
 * @api public
 */
IRCb.prototype.kick = function kick(channel, nick, message, cb) {
  if (typeof message === 'function') {
    cb = message;
    message = null;
  }

  if (message === null || typeof message === 'undefined') {
    message = nick;
  }

  this.write('KICK ' + channel + ' ' + nick + ' :' + message, cb);
};

/**
 * Retrieve a list of users for the given IRC room.
 *
 * @param {String} channel The channel.
 * @param {Fucntion} cb The calblack.
 * @api public
 */
IRCb.prototype.names = function names(channel, cb) {
  var self = this;

  self.write('NAMES ' + channel, function (err) {
    if (err) {
      return cb(err);
    }

    self.on('names', function onNames(replyChannel, names) {
      if (replyChannel === channel) {
        cb(null, names);
        self.removeListener('names', onNames);
      }
    });
  });
};

/**
 * Quit the connection.
 *
 * @param {String} msg The shutdown message.
 * @param {Function} cb The callback.
 * @api public
 */
IRCb.prototype.quit = function quit(msg, cb) {
  var self = this;

  if ('function' === typeof msg) {
    cb = msg;
    msg = null;
  }

  msg = msg || [
    'TTYL, if you also want a better IRC experiance, checkout',
    'http://ircb.io?f='+ crypto.createHash('md5').update(this.ircbio).digest('hex')
  ].join(' ');

  self.write('QUIT :'+ msg, cb);
};

/**
 * Shut down the IRCb connection.
 *
 * @param {String} msg Optional ending message.
 * @param {Function} cb The callback
 * @api public
 */
IRCb.prototype.end = function end(msg, cb) {
  if ('function' === typeof msg) {
    cb = msg;
    msg = null;
  }

  this.quit(msg, function () {
    this.connection.end();
    this.connection = null;

    if (cb) cb();
  }.bind(this));
};

/**
 * Write a new message to the IRC server.
 *
 * @param {String} string The message or command we write to the connection.
 * @param {Function} fn The callback.
 * @return {Boolean} successful write.
 * @api public
 */
IRCb.prototype.write = function write(string, cb) {
  return this.connection.write(string + '\r\n', cb);
};

//
// Expose the module.
//
module.exports = IRCb;
