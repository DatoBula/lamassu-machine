'use strict'

var fs = require('fs')
var EventEmitter = require('events').EventEmitter
var util = require('util')
var async = require('async')
var uuid = require('node-uuid')
var BigNumber = require('bignumber.js')
var axios = require('axios')

var _t0 = null
var sequenceNumber = 0
var pid = uuid.v4()

var Trader = function (config) {
  if (!(this instanceof Trader)) return new Trader(config)
  EventEmitter.call(this)

  this.connectionInfo = null
  this.protocol = config.protocol || 'https'
  this.rejectUnauthorized = typeof config.rejectUnauthorized === 'undefined'
  ? true
  : !!config.rejectUnauthorized

  this.config = config
  this.exchangeRate = null
  this.fiatExchangeRate = null
  this.balance = null
  this.locale = null

  this.exchange = null
  this.balanceTimer = null
  this.balanceRetries = 0
  this.balanceTriggers = null
  this.tickerExchange = null
  this.transferExchange = null
  this.pollTimer = null
  this.pollRetries = 0
  this.txLimit = null
  this.fiatTxLimit = 50  // TODO: make configurable
  this.idVerificationLimit = null
  this.idVerificationEnabled = false
  this.sessionId = null
  this.twoWayMode = false
  this.coins = []
  this.state = null
}
util.inherits(Trader, EventEmitter)

Trader.prototype.init = function init (connectionInfo) {
  var self = this

  if (this.protocol === 'https') {
    this.cert = fs.readFileSync(this.config.certs.certFile)
    this.key = fs.readFileSync(this.config.certs.keyFile)
  }
  this.connectionInfo = connectionInfo

  var agent // agent stuff, certificates
  this.axios = axios.create({agent: agent})

  jsonquest.emitter.on('networkUp', function () { self.emit('networkUp') })
  jsonquest.emitter.on('networkDown', function () { self.emit('networkDown') })
}

Trader.prototype.pair = function pair (connectionInfo) {
  this.connectionInfo = connectionInfo
}

Trader.prototype._request = function _request (options, cb) {
  var protocol = this.protocol || 'https'
  var connectionInfo = this.connectionInfo
  var host = protocol === 'http' ? 'localhost' : connectionInfo.host
  var fingerprint = protocol === 'http' ? false : connectionInfo.fingerprint
  var self = this
  var sessionId = this.sessionId
  var date = new Date().toISOString()
  var headers = sessionId ? {'session-id': sessionId, date: date} : {date: date}
  if (options.body) headers['content-type'] = 'application/json'

  function debug (msg) {
    if (options.repeatUntilSuccess) console.log(msg)
  }

  return this.axios({
    baseUrl: baseUrl,
    method: options.method,
    url: options.path,
    data: options.body,
    headers: headers,
  })
  .then(res => {
    if (sessionId && sessionId !== self.sessionId) {
      console.log('WARN: received a response from old sessionId: %s, ' +
      'current is: %s', sessionId, self.sessionId)
      throw new Error('Old session id')
    }

    // Come up with a good scheme for handling errors
    // Consider: HTTP codes, JS error types, retrying
  })
}

Trader.prototype.run = function run () {
  var self = this

  self.trigger()
  self.triggerInterval = setInterval(function () {
    self.trigger()
  }, this.config.settings.pollInterval)
}

Trader.prototype.stop = function stop () {
  if (this.triggerInterval) clearInterval(this.triggerInterval)
}

Trader.prototype.verifyUser = function verifyUser (idRec, cb) {
  console.log(idRec)
  this._request({
    path: '/verify_user',
    method: 'POST',
    body: idRec
  }, cb)
}

Trader.prototype.rates = function rates (cryptoCode) {
  if (this._rates) return this._rates[cryptoCode]
  if (cryptoCode !== 'BTC') throw new Error('No rates record')

  return {
    cashIn: new BigNumber(this.exchangeRate.toFixed(15)),
    cashOut: new BigNumber(this.fiatExchangeRate.toFixed(15))
  }
}

Trader.prototype.verifyTransaction = function verifyTransaction (idRec) {
  console.log(idRec)
  this._request({
    path: '/verify_transaction',
    method: 'POST',
    body: idRec
  }, function (err) {
    if (err) console.log(err)
  })
}

Trader.prototype.reportEvent = function reportEvent (eventType, note) {
  var rec = {
    eventType: eventType,
    note: note,
    deviceTime: Date.now()
  }
  this._request({
    path: '/event',
    method: 'POST',
    body: rec,
    repeatUntilSuccess: true
  }, function (err) {
    if (err) console.log(err)
  })
}

Trader.prototype.sendCoins = function sendCoins (tx, cb) {
  tx.sequenceNumber = ++sequenceNumber

  // For backwards compatibility with lamassu-server@1.0.2
  tx.txId = uuid.v4()

  this._request({
    path: '/send',
    method: 'POST',
    body: tx,
    repeatUntilSuccess: true
  }, function (err, result) {
    if (!err) {
      cb(null, result.txHash)
    } else {
      console.log('DEBUG31: %s', err)
      if (err.name === 'InsufficientFunds') return cb(err)
      if (err.name === 'networkDown') return cb(new Error('sendCoins timeout'))
      return cb(new Error('General server error'))
    }
  })

  sequenceNumber = 0
}

Trader.prototype.trigger = function trigger () {
  var self = this

  // Not paired yet
  if (this.connectionInfo === null) return

  var stateRec = this.state
  self._request({
    path: '/poll?state=' + stateRec.state + '&idle=' + stateRec.isIdle + '&pid=' + pid,
    method: 'GET'
  }, function (err, body) {
    self._pollHandler(err, body)
  })
}

Trader.prototype.trade = function trade (rec, cb) {
  rec.sequenceNumber = ++sequenceNumber
  this._request({
    path: '/trade',
    method: 'POST',
    body: rec,
    repeatUntilSuccess: true
  }, cb)
}

Trader.prototype.stateChange = function stateChange (state, isIdle) {
  this.state = {state: state, isIdle: isIdle}
  if (!this.connectionInfo) return  // Not connected to server yet
  var rec = {state: state, isIdle: isIdle, uuid: uuid.v4()}
  this._request({
    path: '/state',
    method: 'POST',
    body: rec
  }, function () {})
}

Trader.prototype.cashOut = function cashOut (tx, cb) {
  var config = this.config
  var result = null
  var t0 = Date.now()
  var timeOut = config.settings.sendTimeout
  var interval = config.settings.retryInterval
  var self = this

  // for backwards compatibility
  tx.satoshis = tx.cryptoAtoms

  function _cashOut (cb) {
    self._request({
      path: '/cash_out',
      method: 'POST',
      body: tx
    }, function (err, body) {
      if (!err && body) result = body.bitcoinAddress
      if (err || result === null) return setTimeout(cb, interval)
      cb()
    })
  }

  function testResponse () {
    return result !== null || Date.now() - t0 > timeOut
  }

  function handler (err) {
    if (err) return cb(err)
    if (result === null) return cb(new Error('cashOut timeout'))
    cb(null, result)
  }

  async.doUntil(_cashOut, testResponse, handler)
}

Trader.prototype.phoneCode = function phoneCode (number, cb) {
  this._request({
    path: '/phone_code',
    method: 'POST',
    body: {phone: number}
  }, function (err, res) {
    if (err) return cb(err)
    if (res.statusCode === 401) {
      var badNumberErr = new Error('Bad phone number')
      badNumberErr.name = 'BadNumberError'
      return cb(badNumberErr)
    }
    cb(null, res)
  })
}

// This is just for backwards compatibility with Raqia
// Can be taken out after Raqia is decomissioned
Trader.prototype.updatePhoneNoNotify = function updatePhoneNoNotify (tx, cb) {
  this._request({
    path: '/update_phone?notified=true',
    method: 'POST',
    body: tx
  }, function (err, res) {
    if (err) return cb(err)

    if (res.noPhone) {
      var _err = new Error('Unknown phone number')
      _err.name = 'UnknownPhoneNumberError'
      return cb(_err)
    }

    return cb()
  })
}

Trader.prototype.updatePhone = function updatePhone (tx, cb) {
  this._request({
    path: '/update_phone',
    method: 'POST',
    body: tx
  }, function (err, res) {
    if (err) return cb(err)
    return cb()
  })
}

Trader.prototype.fetchPhoneTx = function fetchPhoneTx (phone, cb) {
  this._request({
    path: '/phone_tx?phone=' + encodeURIComponent(phone),
    method: 'GET'
  }, function (err, res) {
    if (err) return cb(err)

    if (res.pending) return cb(null, {})

    if (!res.tx) {
      var _err = new Error('Unknown phone number')
      _err.name = 'UnknownPhoneNumberError'
      return cb(_err)
    }

    var tx = res.tx
    tx.cryptoAtoms = new BigNumber(tx.cryptoAtoms)

    return cb(null, {tx: tx})
  })
}

Trader.prototype.waitForDispense = function waitForDispense (status, cb) {
  this._request({
    path: '/await_dispense?status=' + status,
    method: 'GET',
    repeatUntilSuccess: true
  }, function (err, res) {
    if (err) return cb(err)

    var tx = res.tx
    tx.cryptoAtoms = new BigNumber(tx.cryptoAtoms)
    return cb(null, tx)
  })
}

Trader.prototype.registerRedeem = function registerRedeem () {
  this._request({
    path: '/register_redeem',
    method: 'POST',
    repeatUntilSuccess: true
  }, function (err) {
    if (err) return console.log(err)
  })
}

Trader.prototype.dispense = function dispense (tx, cb) {
  this._request({
    path: '/dispense',
    method: 'POST',
    body: {tx: tx}
  }, function (err) {
    if (err) return cb(err)
    return cb()
  })
}

// TODO: repeat until success
Trader.prototype.dispenseAck = function dispenseAck (tx, cartridges) {
  this._request({
    path: '/dispense_ack',
    method: 'POST',
    body: {tx: tx, cartridges: cartridges}
  }, function (err) {
    if (err) console.log(err)
  })
}

Trader.prototype._pollHandler = function _pollHandler (err, res) {
  if (err && err.name === 'networkDown') {
    if (_t0 === null) {
      _t0 = Date.now()
      return
    }

    if (Date.now() - _t0 > this.config.settings.pollTimeout) {
      _t0 = null
      this.emit('networkDown')
      return
    }
  }

  if (err && err.name === 'unpair') {
    this.emit('unpair')
    return
  }

  _t0 = null

  // Not a network error, so no need to keep trying
  if (err) {
    if (sequenceNumber === 0) this.emit('networkDown')

    return
  }

  this.txLimit = res.txLimit
  this.idVerificationLimit = res.idVerificationLimit
  this.idVerificationEnabled = false && res.idVerificationEnabled
  this.exchangeRate = res.rate
  this.fiatExchangeRate = res.fiatRate
  this.balance = res.fiat
  this.locale = res.locale
  if (res.cartridges) {
    this.cartridges = res.cartridges.cartridges
    this.virtualCartridges = res.cartridges.virtualCartridges.map(toInt)
    this.cartridgesUpdateId = res.cartridges.id
  }
  this.twoWayMode = res.twoWayMode
  this.fiatTxLimit = res.fiatTxLimit
  this.zeroConfLimit = res.zeroConfLimit
  this._rates = res.rates
  this.balances = res.balances
  this.coins = filterCoins(res)

  if (this.coins.length === 0) return this.emit('networkDown')

  if (res.reboot) this.emit('reboot')
  this.emit('pollUpdate')
  this.emit('networkUp')
}

function filterCoins (res) {
  var coins = res.coins || ['BTC']
  return coins.filter(function (coin) {
    return res.rates[coin] && res.balances[coin]
  })
}

function toInt (str) {
  return parseInt(str, 10)
}

function _richError (errMessage, name) {
  var err = new Error(errMessage)
  err.name = name
  return err
}

module.exports = Trader
