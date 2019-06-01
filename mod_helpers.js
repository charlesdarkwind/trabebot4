const mongoose = require('mongoose');
const Log = mongoose.model('Log');
const moment = require('moment');
const {spawn} = require('child_process');

const saveLog = data => {
    const hasConnection = mongoose.connection.readyState == 1;
    if (!hasConnection) {
        console.log('Mongoose: No mongo connection found.');
        return;
    }
     new Log({
         emitter: data.emitter,
         message: data.message,
         date: data.date,
         error: data.error,
         data: data.data
     }).save((err, doc) => {
         if (err) console.log('mongoose Database error: ', err.message || err);
     });
};

const print = (pair, message, e, other) => {
    try {
        let str = `${pair.padStart(9)} | ${message}`;
        let date = moment().format('MMM D, H:mm:ss');
        str += `${' '.repeat(str.length > 100 ? 100 : 100 - str.length)}| ${date}`;
        console.log(str);
        let errStr = '';
        if (other) console.warn(other);
        if (e) {
            const body = e && e.body ? JSON.parse(e.body) : null;
            if (body && !body.msg && !body.code) errStr += `body: ${body.msg} ${body.code}\n`;
            else if (body) errStr += `${body.msg} ${body.code}\n`; // message, 1st line
            if (typeof e === 'string') errStr = `${e}\n`; // or passed strings
            if (body && body.code === -1022) errStr += `${trace}\n`; // trace specific code
            if (errStr && e.body) console.warn(`\n${str}\n${errStr}`); // e.body? dont show trace
            else if (errStr) console.trace(`\n${str}\n${errStr}\n`); // show trace
            if (!body && typeof e === 'object') console.warn(e); // any error w/o body at the end (can be big)
        }
        if (typeof message != 'string') return;
        saveLog({
            emitter: pair,
            message,
            date,
            error: errStr ? errStr : '',
            data: other
        });
    } catch (err) {
        const errStr = e ? e.body || JSON.stringify(e) : 'no bot err';
        console.warn(
            'bot message: ', message, '\n',
            errStr, '\n',
            err, '\n'
        );
    }
};
exports.print = print;

exports.to = promise => {
    return promise.then(data => {
        return [null, data];
    })
        .catch(err => [err]);
};

exports.repairDatabase = () => {
    print('mongoose', 'Compacting DB filesystem...');
    mongoose.connection.db.command({ repairDatabase: 1 }, (err, res) => {
        if (err) print('mongoose', 'Error when repairing DB.', err);
    });
};

// exports.pythonProg = new Promise((success, err) => {
//     spawn('python', [], )
// });