const moment = require('moment');
const {spawn} = require('child_process');

const print = (pair, message, e, other) => {
    try {
        let str = `${pair.padStart(9)} | ${message}`;
        str += `${' '.repeat(str.length > 70 ? 70 : 70 - str.length)}| ${moment().format('MMM D, H:mm:ss')}`;
        console.log(str);
        if (other) console.warn(other);
        if (e) {
            const body = e && e.body ? JSON.parse(e.body) : null;
            let errStr = '', trace;
            if (body && !body.msg && !body.code) errStr += `body: ${body.msg} ${body.code}\n`;
            else if (body) errStr += `${body.msg} ${body.code}\n`; // message, 1st line
            if (typeof e === 'string') errStr = `${e}\n`; // or passed strings
            if (body && body.code === -1022) errStr += `${trace}\n`; // trace specific code
            if (errStr && e.body) console.warn(`\n${str}\n${errStr}`); // e.body? dont show trace
            else if (errStr) console.trace(`\n${str}\n${errStr}\n`); // show trace
            if (!body && typeof e === 'object') console.warn(e); // any error w/o body at the end (can be big)
            console.warn(e.stack); // todo test
        }
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

// exports.pythonProg = new Promise((success, err) => {
//     spawn('python', [], )
// });