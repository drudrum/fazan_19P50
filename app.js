#!/usr/bin/env node
/* global debugLevel */
const crc = require('crc')
const bitwise = require('bitwise')
require('console.table')
const optimist = require('optimist')
const argv = optimist
  .usage('Использование: fazan --connect <ip/host:port> --freq <num 123.5> --status')
  .string('connect')
  .describe('connect', '<ip/host>:<port> порта. Пример: 192.168.127.254:4002')
  .default('device', 1)
  .describe('device', 'Номер устройства')
  .describe('freq', 'Установить рабочую частоту')
  .string('kf')
  .default('kf', '01')
  .describe('kf', '\n' +
'       00 – частота с шагом сетки 8,33 кГц;\n' +
'       01 – частота с шагом сетки 25 кГц без смещения несущей;\n' +
'       10 – частота с шагом сетки со смещением частоты вниз на 5 кГц;\n' +
'       11 – частота с шагом сетки со смещением частоты вверх на 5 кГц;')
  .describe('noiseSuppressor', 'Подавитель шума 0-выкл 1-вкл')
  .boolean('enableTransmit')
  .describe('enableTransmit', 'Включить излучение')
  .boolean('disableTransmit')
  .describe('disableTransmit', 'Выключить излучение')
  .boolean('test')
  .describe('test', 'Запуск принудительного тестирования')
  .boolean('id')
  .describe('id', 'Получить идентификатор РС')
  .boolean('status')
  .describe('status', 'Чтение содержимого регистров')
  .alias('fullInfo', 'info')
  .boolean('fullInfo')
  .describe('fullInfo', 'Тоже самое что и status, но без пропуска неактивных ошибок')
  .string('reg')
  .describe('reg', 'Запись произвольного бита в регистр. Пример: MR1:7:1')
  .boolean('nocolor')
  .describe('nocolor', 'Монохромный вывод')
  .boolean('help')
  .describe('help', 'Вывод справки')
  .argv

const color = {
  Reset: '\x1b[0m',
  Reverse: '\x1b[7m',
  FgRed: '\x1b[31m',
  FgGreen: '\x1b[32m',
  FgMagenta: '\x1b[35m'
}

if (argv.nocolor) {
  for (var key in color) {
    color[key] = ''
  }
}

global.debugLevel = 0 || argv.debug
var freqStep = 8333.33333
if (argv.help) {
  optimist.showHelp()
  process.exit(0)
}
function buf2hex (buffer) { // buffer is an ArrayBuffer
  return Array.prototype.map.call(new Uint8Array(buffer), x => ('00' + x.toString(16)).slice(-2)).join('').toUpperCase()
}

function now () {
  return (new Date()).getTime()
};

var net = require('net')
var client = new net.Socket()
var queue = []
var responseCbTimeout = null
var operationData = null
var lastActivity = now() - 1000

function trySend () {
  if (queue.length === 0) {
    console.log('Очередь комманд пуста, завершение приложения.')
    client.end()
    return
  }
  if (responseCbTimeout) return

  var timeFromPrevCommand = now() - lastActivity
  if (timeFromPrevCommand < 2000) {
    debugLevel > 4 && console.log('Задержка комманды на %s мсек', timeFromPrevCommand)
    setTimeout(trySend, (timeFromPrevCommand < 2000) ? (2000 - timeFromPrevCommand) : 2000)
    return
  }

  operationData = queue.shift()

  // Нет ответа
  var timeoutOperationFunc = function (od) {
    console.log('Таймаут ожидания ответа. Повтор отправки комманды ' + od.caption)
    global.debugLevel > 0 && console.log('Отправка в порт:', buf2hex(od.cmd))
    client.write(od.cmd)
    responseCbTimeout = setTimeout(timeoutOperationFunc, 2000, operationData)
  }
  responseCbTimeout = setTimeout(timeoutOperationFunc, 2000, operationData)

  operationData.caption && console.log('Отправка комманды ' + operationData.caption)
  global.debugLevel > 0 && console.log('Отправка в порт:', buf2hex(operationData.cmd))
  client.write(operationData.cmd)
  lastActivity = now()
}

var sendCmd = function (hexCmd, caption, mcb) {
  var cb = (typeof (caption) === 'function' && !mcb) ? caption : mcb
  var deviceAddrBuf = Buffer.alloc(1); deviceAddrBuf.writeUInt8(Number(argv.device), 0)
  var hex = buf2hex(deviceAddrBuf) + hexCmd
  var buf = Buffer.from(hex, 'hex')
  var bufCrc = Buffer.alloc(2)

  bufCrc.writeUInt16LE(crc.crc16modbus(buf), 0)
  var cmd = Buffer.concat([buf, bufCrc], buf.length + bufCrc.length)

  queue.push({
    caption: (typeof (caption) === 'string') ? caption : hexCmd,
    cmd: cmd,
    hexCmd: hex,
    buf: buf,
    cb: cb
  })
  trySend()
}

var processResponseTimeout = null
var response = Buffer.alloc(0)
function processResponse () {
  if (!operationData) return
  clearTimeout(responseCbTimeout)
  lastActivity = now()

  if (response.length <= 2) {
    operationData.cb('Очень короткий ответ')
    responseCbTimeout = null
    trySend()
    return
  }
  var rcvCrc = response.slice(response.length - 2, response.length)
  var buf = response.slice(0, response.length - 2)
  response = Buffer.alloc(0)
  var bufCrc = Buffer.alloc(2)
  bufCrc.writeUInt16LE(crc.crc16modbus(buf), 0)

  if (!rcvCrc.equals(bufCrc)) {
    console.log('Wrong CRC: ' + buf2hex(response))
    operationData.cb('Неверный CRC')
    responseCbTimeout = null
    trySend()
    return
  }

  if ((Buffer.from('80', 'hex')).readUInt8(0) + operationData.cmd.readUInt8(1) === buf.readUInt8(1)) {
    var errCode = buf2hex(buf).slice(4, 6)
    var err = 'Неизвестная ошибка'

    switch (errCode) {
      case '02':
        err = 'Недопустимый адрес данных (в запросе указан недопустимый для данного ВЕДОМОГО устройства адрес данных)'
        break
      case '03':
        err = 'Ошибка данных (попытка записи в регистры, предназначенные только для чтения или запись в регистры в режиме излучения)'
        break
      case '06':
        err = 'Устройство занято записью информации в РПЗУ'
        break
      case '09':
        err = 'Попытка модифицировать регистры в РС, находящиеся в режиме местного управления'
        break
    }
    operationData.cb(err + ' ErrCode:' + errCode + ' response:' + buf2hex(buf))
    responseCbTimeout = null
    trySend()
    return
  }

  operationData.cb(null, buf)
  responseCbTimeout = null
  trySend()
}

client.on('data', function (data) {
  response = Buffer.concat([response, data], response.length + data.length)
  global.debugLevel > 2 && console.log('data: ' + buf2hex(data))
  processResponseTimeout && clearTimeout(processResponseTimeout)
  processResponseTimeout = setTimeout(processResponse, 50)
})

function setFreq () {
  var diff = (Number(String(argv.freq).replace(/,/g, '.')) - 100) * 1000000
  var kf = argv.kf.split('')
  for (var i = 0; i < kf.length; i++) { kf[i] = Number(kf[i]) }
  var f12 = Math.round(diff / freqStep)
  const buf = Buffer.allocUnsafe(2)
  buf.writeUInt16BE(f12, 0)
  var fsRsArray = [0, kf[0], kf[1]].concat(bitwise.buffer.read(buf, 3, 13))
  var frRs = bitwise.buffer.create(fsRsArray)

  sendCmd('100005000102' + buf2hex(frRs), 'Установка частоты:' + argv.freq + ' kf:' + argv.kf, function (err, data) {
    if (err) return console.log('Error:' + err)
    console.log('Response', buf2hex(data))
  })
}

var registerMap = [
  {
    name: 'CW1',
    caption: 'Наработка в часах LO',
    readonly: true,
    out: (val, register, prevRegister) => {}
  }, {
    name: 'CW2',
    caption: 'Наработка в часах HI',
    readonly: true,
    out: (val, register, prevRegister) => {
      var CW = Buffer.concat([val.buf, prevRegister.val.buf], 4)
      // CW=new Buffer('0001F392','hex');
      var cwInt = CW.readUInt32BE()
      var h = Number(cwInt)
      var years = Math.floor((h / 24) / 365)
      h -= (years * 365 * 24)
      var days = Math.floor(h / 24)
      h -= (days * 24)

      val.human.push({
        caption: 'Наработка часов',
        val: cwInt
      })
      val.human.push({
        caption: 'Наработка',
        val: 'Годов:' + years + ' Дней:' + days + ' Часов:' + h
      })
    }
  }, {
    name: 'Cntr',
    caption: 'Регистр запросов',
    description: {
      '00': 'нет запроса',
      '01': 'запрос включения принудительного теста',
      '02': 'запрос включения излучения',
      '03': 'запрос выключения излучения'
    },
    out: (val, curReg) => {
      val.human.push({
        val: (curReg.description[buf2hex(val.hiBuf)] || '') + ' ' + buf2hex(val.hiBuf) + 'h ' + buf2hex(val.loBuf) + 'h'
      })
    }
  }, {
    name: 'MR1',
    caption: 'режимы работы РС',
    twoState: true,
    bits: [
      'телефония/данные',
      '2/4–х проводный режим',
      'режим МУ/ДУ',
      'режим ретрансляции выключен/включен',
      'АРУ ПРД выключено/включено',
      'АРУ ПРМ выключено/включено',
      'режим звуковой сигнализации нажатия кнопок выключен/включен',
      'подавитель шума приемника выключен/включен',
      'работа реле СОН запрещена/разрешена',
      'реле СОН включается при появлении/пропадании СОН',
      'РС основное/резервное',
      'реакция на ОТКАЗ ВЧ запрещена/разрешена',
      'режим пониженной чувствительности приемника выключен/включен',
      'самопрослушивание сигнала передатчика выключено/включено',
      'постоянное включение режима передачи в ДУ выключено/включено',
      'возможность перевода РС в режим дежурного приема по ДУ запрещена/разрешена'
    ]
  }, {
    name: 'MR2',
    caption: 'режимы работы РС',
    twoState: true,
    bits: [
      'выключение/включение режима дежурного приема',
      'Резерв',
      'Резерв',
      'Резерв',
      'Резерв',
      'Резерв',
      'Резерв',
      'Резерв',
      'Резерв',
      'Резерв',
      'Резерв',
      'Резерв',
      'Резерв',
      'Резерв',
      'Резерв',
      'Резерв'
    ]
  }, {
    name: 'FrRS',
    caption: 'Рабочая частота',
    out: (val) => {
      var kf = String(val.hi[1]) + String(val.hi[2])
      var freq = bitwise.buffer.readUInt(val.buf, 3, 13)
      freq *= freqStep
      freq = freq / 1000000
      freq = freq + 100
      val.human.push({
        caption: 'Рабочая частота',
        val: freq.toFixed(6) + 'Mhz'
      })
      val.human.push({
        caption: 'kf',
        val: kf
      })
    }
  }, {
    name: 'PKm',
    readonly: true,
    caption: 'Содержит информацию о мощности несущей передатчика (старший байт) и коэффициенте глубины ам-плитудной модуляции (младший байт).',
    out: (val) => {
      val.human.push({
        caption: 'Мощность несущей передатчика, Ватт (Фазан-19Р5 Ватт/10)',
        val: val.hiBuf.readUInt8()
      })
      val.human.push({
        caption: 'Коэффициент глубины амплитудной модуляции',
        val: val.loBuf.readInt8()
      })
    }
  }, {
    name: 'KSW',
    caption: 'содержит в старшем байте значение коэффициента стоячей волны в безразмерных единицах (согласованной нагрузке соответствует КСВ = 1), младший байт содержит 0',
    readonly: true,
    out: (val) => {
      val.human.push({
        caption: 'Коэффициент стоячей волны (согл. нагрузке соотв. КСВ=1)',
        val: val.hiBuf.readInt8()
      })
    }
  }, {
    name: 'TC',
    readonly: true,
    caption: 'содержит значения температуры платы КИ (старший байт) и радиатора усилителя мощности (младший байт) в градусах Цельсия в дополнительном коде',
    out: (val) => {
      val.human.push({
        caption: 'Температура платы КИ',
        val: val.hiBuf.readInt8() + '°С'
      })
      val.human.push({
        caption: 'Температура радиатора усилителя мощности',
        val: val.loBuf.readInt8() + '°С'
      })
    }
  }, {
    name: 'Varu',
    caption: 'содержит кодированные значения коэффициента глубины амплитудной модуляции (старший байт) и напряжения в физической линии (младший байт)',
    out: (val) => {
      var aruPrd = { 0: '60%', 1: '70%', 2: '80%', 3: '90%' }
      var aruPrm = { 0: 'минус 6 дБм', 1: 'минус 3 дБм', 2: '0 дБм', 3: 'плюс 3 дБм' }
      val.human.push({
        caption: 'Коэффициент глубины амплитудной модуляции',
        val: val.hiBuf.readUInt8() + ' - ' + (aruPrd[val.hiBuf.readUInt8()] || '?')
      })
      val.human.push({
        caption: 'Напряжение в физической линии',
        val: val.loBuf.readUInt8() + ' - ' + (aruPrm[val.loBuf.readUInt8()] || '?')
      })
    }
  }, {
    name: 'SQL',
    caption: 'представляет собой кодированное значение порога (отношения (сигнал + шум)/шум) открыва-ния подавителя шума приемника (старший байт), младший байт содержит 0',
    out: (val) => {
      var sqlV = {
        0: '6 дБ',
        1: '8 дБ',
        2: '10 дБ',
        3: '12 дБ',
        4: '14 дБ',
        5: '16 дБ',
        6: '18 дБ'
      }
      val.human.push({
        caption: 'Порог открывания подавителя шума приемника',
        val: val.hiBuf.readUInt8() + ' - ' + (sqlV[val.hiBuf.readUInt8()] || '?')
      })
    }
  }, {
    name: 'Din',
    caption: 'представляет собой значения чувствительности модуляционного входа для микрофонного входа в режиме МУ (старший байт) и линейного входа (ФЛ) в режиме ДУ (младший байт).',
    out: (val) => {
      val.human.push({
        caption: 'Чувствительность модуляционного входа для микрофонного входа в режиме МУ',
        val: val.hiBuf.readUInt8()
      })
      val.human.push({
        caption: 'Чувствительность модуляционного входа для линейного входа (ФЛ) в режиме ДУ',
        val: val.loBuf.readUInt8()
      })
    }
  }, {
    name: 'DTO',
    caption: 'представляет собой значения уровней громкости на внешний динамик (старший байт) и в физическую линию в режиме ДУ с выключенной АРУ ПРМ (младший байт).',
    out: (val) => {
      val.human.push({
        caption: 'Уровень громкости на внешний динамик',
        val: val.hiBuf.readUInt8() + ' ' + Math.round((val.hiBuf.readUInt8() / 255) * 100) + '%'
      })
      val.human.push({
        caption: 'Уровень громкости на физическую линию в режиме ДУ с выключенной АРУ ПРМ',
        val: val.loBuf.readUInt8() + ' ' + Math.round((val.loBuf.readUInt8() / 255) * 100) + '%'
      })
    }
  }, {
    name: 'StRS',
    readonly: true,
    bitOnlyIfTrue: true,
    caption: 'текущее состояние РС и признаки отказов',
    bits: [
      'Izl485=1 режим излучения включен',
      'EndTest=1 флаг окончания принудительного теста',
      'СОН=1 сигнал обнаружения несущей на входе приемника',
      'Резерв',
      'Резерв',
      'Резерв',
      'Резерв',
      'Резерв',
      'ErrP_VUU=1 отсутствует мощность после включения режима излучения',
      'ErrM_VUU=1 отсутствует модуляция после включения режима излучения',
      'ErrRF_VUU=1 отказ ВЧ (обрыв антенного кабеля)',
      'ErrAFU_VUU=1 недопустимый КСВ в нагрузке усилителя мощности (отказ АФУ)',
      'ErrPRM_VUU=1 неисправен приемный тракт (нет выхода НЧ)',
      'Резерв',
      'Резерв',
      'Резерв'
    ]
  }, {
    name: 'Pout',
    caption: 'представляет собой устанавливаемый уровень выходной мощности передатчика (старший байт), младший байт содержит 0',
    out: (val) => {
      var vd = {
        '00': 'равна максимальной для данного РС',
        '01': 'равна 1/2 от максимальной',
        '02': 'равна 1/4 от максимальной',
        '03': 'равна 1/8 от максимальной'
      }
      val.human.push({
        caption: 'Уровень выходной мощности передатчика',
        val: buf2hex(val.hiBuf) + ' - ' + (vd[buf2hex(val.hiBuf)] || '')
      })
    }
  }, {
    name: '0Fh',
    readonly: true
  }, {
    name: 'AD0',
    readonly: true,
    caption: 'уровень сигнала в физической линии 1',
    out: (val) => { val.human.push({ val: val.buf.readUInt16BE() + ' милливольт' }) }

  }, {
    name: 'AD1',
    readonly: true,
    caption: 'уровень сигнала в физической линии 2',
    out: (val) => { val.human.push({ val: val.buf.readUInt16BE() + ' милливольт' }) }
  }, {
    name: 'AD2',
    readonly: true,
    caption: 'уровень модулирующего сигнала, поступающего на усилитель мощности',
    out: (val) => { val.human.push({ val: val.buf.readUInt16BE() + ' милливольт' }) }
  }, {
    name: 'AD3',
    readonly: true,
    caption: 'уровень отфильтрованного сигнала с приемника',
    out: (val) => { val.human.push({ val: val.buf.readUInt16BE() + ' милливольт' }) }
  }, {
    name: 'AD4',
    readonly: true,
    caption: 'напряжение аккумуляторной батареи после защитного диода',
    out: (val) => { val.human.push({ val: val.buf.readUInt16BE() + ' милливольт' }) }
  }, {
    name: 'AD5',
    readonly: true,
    caption: 'выходное напряжение основного источника питания +24В',
    out: (val) => { val.human.push({ val: val.buf.readUInt16BE() + ' милливольт' }) }
  }, {
    name: 'AD6',
    readonly: true,
    caption: 'значение сигнала RSSI',
    out: (val) => { val.human.push({ val: val.buf.readUInt16BE() + ' милливольт' }) }
  }, {
    name: 'AD7',
    readonly: true,
    caption: 'обобщенный модулирующий сигнал',
    out: (val) => { val.human.push({ val: val.buf.readUInt16BE() + ' милливольт' }) }
  }, {
    name: 'DV1',
    readonly: true,
    bitOnlyIfTrue: true,
    caption: 'отказы блоков',
    bits: [
      'Отказ платы УП',
      'Отказ платы КИ',
      'Отказ приемника (платы ПРМ-СИНТ)',
      'Отказ блока внешних интерфейсов (ВИ, ВИ-ПРД, П-ВИ)',
      'Отказ усилителя мощности',
      'Отказ ПРДИ',
      'Отказ возбудителя СВ-150',
      'Отказ шины I2C',
      'Отказ порта 0',
      'Отказ порта 1',
      'Отказ РПЗУ',
      'Отказ цифрового потенциометра 0',
      'Отказ цифрового потенциометра 1',
      'Отказ цифрового потенциометра 2',
      'Отказ цифрового потенциометра 3',
      'Отказ цифро-аналогового преобразователя'
    ]
  }, {
    name: 'DV2',
    readonly: true,
    bitOnlyIfTrue: true,
    caption: 'детализация отказов платы КИ, детализация отказов платы ПРМ-СИНТ',
    bits: [
      'Отказ порта 0 клавиатуры',
      'Отказ порта 1 клавиатуры',
      'Отказ порта 2 индикатора',
      'Резерв',
      'Отказ термодатчика',
      'Резерв',
      'Резерв',
      'Резерв',
      'Отказ РПЗУ',
      'Отказ калибровки ПРМ',
      'Отказ УГ',
      'Резерв',
      'Отказ ДПКД гетеродина',
      'Отказ кольца ФАПЧ гетеродина',
      'Отказ ПЧ приемника',
      'Резерв'
    ]
  }, {
    name: 'DV3',
    readonly: true,
    bitOnlyIfTrue: true,
    caption: 'детализация отказов блока внешних интерфейсов, усилителя мощности',
    bits: [
      'Отказ порта 0',
      'Отказ порта 1',
      'Резерв',
      'Резерв',
      'Резерв',
      'Резерв',
      'Резерв',
      'Резерв',
      'Нет мощности в режиме излучения',
      'Отказ РПЗУ',
      'Отказ цифро-аналогового преобразователя',
      'Отказ цифрового потенциометра',
      'Отказ термодатчика',
      'Отказ ВЧ',
      'Отказ АФУ',
      'Авария обмена с УМ'
    ]
  }, {
    name: 'DV4',
    readonly: true,
    bitOnlyIfTrue: true,
    caption: 'детализация отказов платы ПРДИ, отказов возбудителя СВ-150',
    bits: [
      'Отказ порта 0',
      'Отказ порта 1',
      'Отказ порта 2',
      'Отказ порта 3',
      'Резерв',
      'Резерв',
      'Резерв',
      'Резерв',
      'Отказ ДПКД возбудителя',
      'Отказ кольца ФАПЧ возбудителя',
      'Резерв',
      'Резерв',
      'Резерв',
      'Резерв',
      'Резерв',
      'Резерв'
    ]
  }
]

function changeRegisterBit (register, bitNo, value) {
  registerMap.forEach((curReg, regNo) => {
    if (curReg.name !== register) return

    if (!curReg.bits) console.log('Данного регистр не состоит из бит')
    if (curReg.readonly) console.log('Регистр только для чтения')

    const regAddr = Buffer.allocUnsafe(1)
    regAddr.writeUInt8(regNo, 0)
    sendCmd('0300' + buf2hex(regAddr) + '0001', 'Получить регистр ' + register, function (err, data) {
      if (err) return console.log('Error:' + err)
      global.debugLevel > 4 && console.log('Register data', buf2hex(data.slice(3, 5)))

      var realIndex = bitNo < 8 ? (7 - bitNo) : (15 - bitNo)
      var registerBits = bitwise.buffer.read(data.slice(3, 5))
      global.debugLevel > 3 && console.log('oldbit:%s newbit:%s', registerBits[realIndex], value, realIndex)
      registerBits[realIndex] = value
      var newRegisterBuf = bitwise.buffer.create(registerBits)

      sendCmd('1000' + buf2hex(regAddr) + '000102' + buf2hex(newRegisterBuf), 'Записать регистр ' + register + '. Новое значение ' + String(value) + '. ' + curReg.bits[bitNo], function (err, data) {
        if (err) return console.log('Error:' + err)
        console.log('Записано успешно')
      })// write
    })// read
  })
}

client.on('error', function (err) {
  console.log('Ошибка сети', err && err.toString())
})

var connect = String(argv.connect || '').split(/:/)
if (!connect || connect.length !== 2) {
  console.log('Неверный адрес подключения.\nПример:"--connect 192.168.127.254:4002"\n\n')
  optimist.showHelp()
  process.exit(0)
}
// Работа с устройством
client.connect(Number(connect[1]), connect[0], function () {
  global.debugLevel > 0 && console.log('Порт подключен')

  argv.freq && setFreq()

  // Run test
  argv.test && sendCmd('100002000102' + '0100', 'Запуск теста', function (err, data) {
    if (err) return console.log('Error:' + err)
    console.log('Тест запущен', buf2hex(data))
    // 01h – запрос включения принудительного теста;
    // 02h – запрос включения излучения;
    // 03h – запрос выключения излучения.
  })

  argv.enableTransmit && sendCmd('100002000102' + '0200', 'Включение передатчика', function (err, data) {
    if (err) return console.log('Error:' + err)
    console.log('Передача запущена ', buf2hex(data))
  })

  argv.disableTransmit && sendCmd('100002000102' + '0300', 'Выключение передатчика', function (err, data) {
    if (err) return console.log('Error:' + err)
    console.log('Передача выключена ', buf2hex(data))
  });

  (argv.id || argv.fullInfo) && sendCmd('11', 'Чтение идентификатора локального устройства', function (err, data) {
    if (err) return console.log('Error:' + err)

    var tbl = []
    tbl.push({
      Параметр: 'Идентификатор РС, uint',
      Значение: data.slice(3, 4).readUInt8()
    })
    tbl.push({
      Параметр: 'Идентификатор РС, hex',
      Значение: buf2hex(data.slice(3, 4)) + 'h'
    })
    tbl.push({
      Параметр: 'РС',
      Значение: buf2hex(data.slice(4, 5)) === '00' ? 'Откл' : 'Вкл'
    })
    var rsSpec = bitwise.buffer.read(data.slice(5, 7))
    tbl.push({
      Параметр: 'Наличие передатчика в составе РС',
      Значение: rsSpec[0] ? 'Есть' : 'Нет'
    })
    tbl.push({
      Параметр: 'наличие приемника в составе РС',
      Значение: rsSpec[1] ? 'Есть' : 'Нет'
    })
    tbl.push({
      Параметр: 'наличие в РС с передатчиком антенного коммутатора',
      Значение: rsSpec[6] ? 'Есть' : 'Нет'
    })
    tbl.push({
      Параметр: 'тип РС с передатчиком',
      Значение: rsSpec[7] ? '50 Вт' : '5 Вт'
    })
    tbl.push({
      Параметр: 'Версия ПО',
      Значение: bitwise.buffer.readUInt(data.slice(6, 7), 0, 2) + '.' + bitwise.buffer.readUInt(data.slice(6, 7), 2, 6)
    })

    console.table('Идентификатор локального устройства', tbl)
  });

  // Read 28 registers
  (argv.status || argv.fullInfo) && sendCmd('030000001C', 'Получить состояние(регистры) устройства', function (err, data) {
    if (err) return console.log('Error:' + err)

    var regBuf = data.slice(3, data.length)
    var totalTable = []
    var reTwoState = /([^\s]+[/][^\s]+)/

    for (var rIdx = 0; rIdx < registerMap.length; rIdx++) {
      var bitOffset = rIdx * 16
      var hi = bitwise.buffer.read(regBuf, bitOffset, 8).reverse()
      var lo = bitwise.buffer.read(regBuf, bitOffset + 8, 8).reverse()
      var curReg = registerMap[rIdx]
      var val = {
        hi: hi,
        hiBuf: regBuf.slice((rIdx * 2), (rIdx * 2) + 1),
        lo: lo,
        loBuf: regBuf.slice((rIdx * 2) + 1, (rIdx * 2) + 2),
        buf: regBuf.slice((rIdx * 2), (rIdx * 2) + 2),
        human: []
      }
      curReg.val = val

      if (curReg.bits) {
        val.bits = hi.concat(lo)
        curReg.bits.forEach((bit, i) => {
          var caption = null
          if (curReg.twoState && reTwoState.test(bit)) {
            var capAr = reTwoState.exec(bit)[1].split(/[/]/)
            capAr[val.bits[i]] = (val.bits[i] === 0 ? color.FgGreen : color.FgMagenta) + capAr[val.bits[i]] + color.Reset
            caption = bit.replace(reTwoState, capAr.join('/'))
          }

          if (/EndTest=1/.test(bit)) caption = bit;

          (bit !== 'Резерв' || (argv.fullInfo && bit === 'Резерв')) &&
          (argv.fullInfo || (curReg.bitOnlyIfTrue && val.bits[i] === 1) || !curReg.bitOnlyIfTrue) &&
          val.human.push({
            caption: (!curReg.bitOnlyIfTrue ? '[' + String(i) + ']' : '') +
            (caption || ((curReg.bitOnlyIfTrue ? (val.bits[i] === 1 ? color.FgRed : color.FgGreen) : '') + bit + (curReg.bitOnlyIfTrue ? color.Reset : ''))),
            val: (val.bits[i] === 1 ? (curReg.twoState ? color.FgMagenta : color.FgRed) : color.FgGreen) + val.bits[i] + color.Reset
          })
        })
      }
      curReg.out && curReg.out(val, curReg, registerMap[rIdx - 1])

      val.human.forEach((hv) => {
        hv.reg = curReg.name
        hv.caption = hv.caption || curReg.caption
      })
      totalTable = totalTable.concat(val.human)
    }
    totalTable.forEach((hv) => {
      hv['Регистр'] = hv.reg; delete hv.reg
      hv['Параметр'] = hv.caption; delete hv.caption
      hv['Значение'] = hv.val; delete hv.val
    })
    console.table('Вывод значений из регистров', totalTable)
  });// status

  // Подавитель шума
  [0, 1].indexOf(argv.noiseSuppressor) > -1 && changeRegisterBit('MR1', 7, argv.noiseSuppressor)

  if (argv.reg) {
    var regParams = String(argv.reg).split(/[:,.\s]+/g)
    if (regParams.length !== 3) return console.log('Неверный ввод.\n Пример: --reg MR1:7:1')
    var bitNo = Number(regParams[1])
    if (bitNo < 0 || bitNo > 15) return console.log('Номер бита должен быть от 0 до 15')
    changeRegisterBit(regParams[0], bitNo, Number(regParams[2]))
  }
})
