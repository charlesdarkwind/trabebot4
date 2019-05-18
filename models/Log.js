const mongoose = require('mongoose');
mongoose.Promise = global.Promise;

const logSchema = new mongoose.Schema({
    emitter: {
        type: String
    },
    message: {
        type: String
    },
    date: {
        type: String
    },
    error: {
        type: String
    },
    data: {
        type: String
    }
});

module.exports = mongoose.model('Log', logSchema);