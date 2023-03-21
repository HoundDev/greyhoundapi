const crypto = require('crypto');

const AES_METHOD = 'aes-256-cbc';
const IV = 'upv4randtatlgyt7'

const password = 'lbwyBzfgzUIvXZFShJuikaWvLJhIVq36'

const decrypt = (text, password) => {
    let textParts = text.split(':');
    let iv = Buffer.from(textParts.shift(), 'hex');
    let encryptedText = Buffer.from(textParts.join(':'), 'hex');
    let decipher = crypto.createDecipheriv(AES_METHOD, Buffer.from(password), iv);
    let decrypted = decipher.update(encryptedText);

    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString();
}

const encrypt = (text, password) => {
    let iv = Buffer.from(IV, 'utf8'); // 'upv4randtatlgyt7
    let cipher = crypto.createCipheriv(AES_METHOD, Buffer.from(password), iv);
    let encrypted = cipher.update(text);

    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

// console.log(decrypt('7570763472616e647461746c67797437:217510acd03bddbe43721d75a5201f13', password))
console.log(encrypt('501', password))
