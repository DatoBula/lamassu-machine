'use strict'

const serialPort = require('serialport')
const SerialPort = serialPort.SerialPort
const EventEmitter = require('events')
const fsm = require('./f56-fsm')
const dLevelFsm = require('./f56-dlevel-fsm')
const R = require('ramda')
const bills = require('./bills')
const serialOptions = {baudRate: 9600, parity: 'even', dataBits: 8, stopBits: 1}
const FS = 0x1c

var serial

class Emitter extends EventEmitter {}
const emitter = new Emitter()

function create (device) {
  serial = new SerialPort(device, serialOptions, false)

  return new Promise((resolve, reject) => {
    serial.open(error => {
      if (error) return reject(error)

      console.log('INFO F56 Connected')
      serial.on('data', data => parse(data))
      serial.on('close', () => emitter.emit('disconnected'))
      resolve()
    })
  })
}

function parse (buf) {
  for (let byte of buf) {
    fsm.rx(byte)
  }
}

function initialize (currency, topDenom, bottomDenom) {
  const ODR = 0x00  // Change for Australia and shutter options
  const billData = bills[currency]
  const lengths = [billData.lengths[topDenom], billData.lengths[bottomDenom], 0x00, 0x00, 0x00, 0x00]
  const thicknesses = R.repeat(billData.thickness, 4)
  const command = new Buffer(R.flatten([0x60, 0x02, 0x0d, ODR, lengths, thicknesses, FS]))

  return request(command)
  .then(res => {
    if (res[0] === 0xf0) {
      console.error('F56 Error')
      console.error(prettyHex(res))
      throw new Error('F56 Error')
    }

    if (res[1] !== 0x02 || res[2] !== 0x34) throw new Error('Invalid F56 response header')
  })
}

function billCount (c1, c2) {
  const ODR = 0xe4
  const billCounts = [D(c1), D(c2), D(0), D(0)]
  const rejects = [D(4), D(4), D(4), D(4)]
  const retries = [3, 3, 3, 3]
  const command = new Buffer(R.flatten([0x60, 0x03, 0x15, ODR, billCounts, rejects, retries, FS]))

  return request(command)
  .then(res => {
    if (res[0] === 0xf0) {
      console.error('F56 Error')
      console.error(prettyHex(res))
      throw new Error('F56 Error')
    }

    if (res[1] !== 0x03 || res[2] !== 0x99) throw new Error('Invalid F56 response header')

    const dispensed1 = DP(res.slice(0x27, 0x29))
    const dispensed2 = DP(res.slice(0x29, 0x2b))
    const rejected1 = DP(res.slice(0x2f, 0x31))
    const rejected2 = DP(res.slice(0x31, 0x33))

    return ({accepted: [dispensed1, dispensed2], rejected: [rejected1, rejected2]})
  })
}

function billsPresent () {
  const command = new Buffer(R.flatten([0x00, 0x01, FS]))

  return request(command)
  .then(res => {
    if (res[0] === 0xf0) {
      console.error('F56 Error')
      console.error(prettyHex(res))
      throw new Error('F56 Error')
    }

    const sensorRegister = res.slice(0x0c, 0x12)
    console.log('DEBUG33: Sensor register')
    console.log(prettyHex(sensorRegister))

    const billsPresent = (sensorRegister[2] & 0x10) > 0
    ? 'bills present'
    : 'no bills present'

    console.log(billsPresent)
  })
}

function request (command) {
  return new Promise((resolve, reject) => {
    if (dLevelFsm.state !== 'Idle') {
      return reject(new Error('Can\'t send in state: ' + dLevelFsm.state))
    }

    const rs232StatusPointer = fsm.on('status', status => dLevelFsm.handle(status))
    const rs232FramePointer = fsm.on('frame', frame => dLevelFsm.handle('frame', frame))

    const statusPointer = dLevelFsm.on('status', (status, frame) => {
      rs232FramePointer.off()
      rs232StatusPointer.off()
      statusPointer.off()
      if (status === 'Response') return resolve(frame)
      return reject(new Error(status))
    })

    fsm.tx(command)
    dLevelFsm.handle('waitForResponse')
    fsm.tx(command)
  })
}

function prettyHex (buf) {
  const pairs = []
  for (let i = 0; i < buf.length; i++) {
    pairs.push((buf.slice(i, i + 1).toString('hex')))
  }

  return pairs.join(' ')
}

function parity (x) {
  let y
  y = x ^ (x >> 1)
  y = y ^ (y >> 2)
  y = y ^ (y >> 4)
  y = y ^ (y >> 8)
  y = y ^ (y >> 16)
  return x + (y & 1) * 0x80
}

function D (n) {
  let str = n.toString(10)
  if (str.length === 1) str = '0' + str
  return [parity(str.charCodeAt(0)), parity(str.charCodeAt(1))]
}

function DP (buf) {
  console.log('DEBUG3')
  console.log(buf.toString('hex'))
  const str = String.fromCharCode(buf[0] & 0x7f, buf[1] & 0x7f)
  console.log(str)
  return parseInt(str, 10)
}

fsm.on('send', s => {
  console.log('sending: %s', prettyHex(s))
  serial.write(s)
})

create(process.argv[2])
.then(() => initialize('EUR', 5, 50))
.then(() => billCount(2, 0))
.then(res => console.dir(res))
.then(() => setInterval(billsPresent, 1000))
.catch(e => {
  console.log(e)
  serial.drain()
  serial.close()
})

/*
.then(() => serial.close())
*/
