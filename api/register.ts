import { createOperationHandler } from '../src/contracts/http.js';
import { handleRegister } from '../src/contracts/register.js';

export default createOperationHandler('register', handleRegister);
