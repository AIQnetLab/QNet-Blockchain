// Amounts as the mobile app writes and reads them (utils/amountFormat.js, utils/sendAmount.js), compiled from its
// source, so both wallets print the same figures and read a pasted one alike: the whole part grouped and the decimal mark
// of the language, and a figure pasted in that language's format taken as written.
export { amountText } from '../../../../qnet-mobile/src/utils/amountFormat.js';
export { amountInput } from '../../../../qnet-mobile/src/utils/sendAmount.js';
