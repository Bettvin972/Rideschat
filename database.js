require('dotenv').config();

const { Sequelize, DataTypes, Op } = require('sequelize');

const DATABASE_URL = process.env.DATABASE_URL || '';
const DB_DIALECT = process.env.DB_DIALECT || (DATABASE_URL? undefined : 'sqlite');
const DB_STORAGE = process.env.DB_STORAGE || 'induu.sqlite';

const sequelize = DATABASE_URL
 ? new Sequelize(DATABASE_URL, {
      dialect: DB_DIALECT,
      logging: process.env.DB_LOGGING === 'true'? console.log : false,
      pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
      dialectOptions: DB_DIALECT === 'postgres'? { ssl: process.env.DB_SSL === 'true'? { require: true, rejectUnauthorized: false } : false } : {},
    })
  : new Sequelize({
      dialect: 'sqlite',
      storage: DB_STORAGE,
      logging: process.env.DB_LOGGING === 'true'? console.log : false,
    });

const USER_DEFAULTS = {
  rating: 5,
  ratingCount: 0,
  isOnline: false,
};

const User = sequelize.define('User', {
  phone: { type: DataTypes.STRING(32), allowNull: false, unique: true, validate: { notEmpty: true, len: [7, 32] } },
  name: { type: DataTypes.STRING(80), allowNull: true },
  rating: { type: DataTypes.FLOAT, allowNull: false, defaultValue: USER_DEFAULTS.rating, validate: { min: 1, max: 5 } },
  ratingCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: USER_DEFAULTS.ratingCount, validate: { min: 0 } },
  location: { type: DataTypes.STRING(100), allowNull: true },
  filterFrom: { type: DataTypes.STRING(100), allowNull: true },
  filterTo: { type: DataTypes.STRING(100), allowNull: true },
  onlineDate: { type: DataTypes.STRING(10), allowNull: true },
  isOnline: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  onlineUntil: { type: DataTypes.DATE, allowNull: true },
  lastSeenAt: { type: DataTypes.DATE, allowNull: true },
}, {
  indexes: [
    { unique: true, fields: ['phone'] },
    { fields: ['isOnline', 'onlineUntil'] },
    { fields: ['location'] },
  ],
});

const RideRequest = sequelize.define('RideRequest', {
  phone: { type: DataTypes.STRING(32), allowNull: false },
  driverPhone: { type: DataTypes.STRING(32), allowNull: true },
  from: { type: DataTypes.STRING(100), allowNull: false },
  to: { type: DataTypes.STRING(100), allowNull: false },
  date: { type: DataTypes.STRING(10), allowNull: false },
  time: { type: DataTypes.STRING(5), allowNull: false },
  seats: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, validate: { min: 1, max: 6 } },
  passengerCount: { type: DataTypes.INTEGER, allowNull: true },
  status: { type: DataTypes.ENUM('OPEN', 'TAKEN', 'COMPLETED', 'CANCELLED', 'EXPIRED'), allowNull: false, defaultValue: 'OPEN' },
  takenAt: { type: DataTypes.DATE, allowNull: true },
  completedAt: { type: DataTypes.DATE, allowNull: true },
  cancelledAt: { type: DataTypes.DATE, allowNull: true },
  timezone: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'America/Chicago' },
  expiresAt: { type: DataTypes.DATE, allowNull: true },
  metadata: { type: DataTypes.JSON, allowNull: true },
}, {
  indexes: [
    { fields: ['status', 'date', 'time'] },
    { fields: ['phone', 'status'] },
    { fields: ['driverPhone', 'status'] },
    { fields: ['expiresAt'] },
    { fields: ['from'] },
    { fields: ['to'] },
  ],
});

const RideOffer = sequelize.define('RideOffer', {
  phone: { type: DataTypes.STRING(32), allowNull: false },
  from: { type: DataTypes.STRING(100), allowNull: false },
  to: { type: DataTypes.STRING(100), allowNull: false },
  date: { type: DataTypes.STRING(10), allowNull: true },
  time: { type: DataTypes.STRING(5), allowNull: true },
  seats: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  status: { type: DataTypes.ENUM('ACTIVE', 'FULL', 'CANCELLED', 'EXPIRED'), allowNull: false, defaultValue: 'ACTIVE' },
  metadata: { type: DataTypes.JSON, allowNull: true },
}, {
  indexes: [
    { fields: ['phone', 'status'] },
    { fields: ['date', 'time'] },
    { fields: ['from', 'to'] },
  ],
});

function normalizePhone(value) {
  return String(value || '').split('@')[0].replace(/[^0-9]/g, '');
}
function cleanLocation(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 100);
}
function isDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [y, m, d] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
function isTime(value) {
  if (!/^\d{2}:\d{2}$/.test(String(value || ''))) return false;
  const [h, m] = String(value).split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}
function localDateTimeToUtc(date, time, timezone) {
  if (!isDate(date) ||!isTime(time)) return null;
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const wanted = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 3; i++) {
    const parts = Object.fromEntries(formatter.formatToParts(guess).filter(x => x.type!== 'literal').map(x => [x.type, x.value]));
    const localAsUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    guess = new Date(guess.getTime() + (wanted - localAsUtc));
  }
  return guess;
}
function calculateExpiry(date, time, timezone) {
  const rideAt = localDateTimeToUtc(date, time, timezone);
  if (!rideAt) return new Date(Date.now() + 24 * 60 * 60 * 1000);
  return new Date(rideAt.getTime() + 2 * 60 * 60 * 1000);
}
function normalizeRideInput(phone, data) {
  const normalized = {
    phone: normalizePhone(phone),
    from: cleanLocation(data.from),
    to: cleanLocation(data.to),
    date: String(data.date || '').trim(),
    time: String(data.time || '').trim(),
    seats: Math.max(1, Math.min(6, Number.parseInt(data.seats, 10) || 1)),
    timezone: String(data.timezone || 'America/Chicago').slice(0, 64),
  };
  normalized.passengerCount = normalized.seats;
  normalized.expiresAt = calculateExpiry(normalized.date, normalized.time, normalized.timezone);
  return normalized;
}
function validateRideInput(data) {
  const errors = [];
  if (!data.phone || data.phone.length < 7) errors.push('Invalid phone');
  if (!data.from || data.from.length < 2) errors.push('Invalid origin');
  if (!data.to || data.to.length < 2) errors.push('Invalid destination');
  if (data.from.toLowerCase() === data.to.toLowerCase()) errors.push('Origin and destination cannot be identical');
  if (!isDate(data.date)) errors.push('Invalid date');
  if (!isTime(data.time)) errors.push('Invalid time');
  try { Intl.DateTimeFormat('en-US', { timeZone: data.timezone }); } catch (_) { errors.push('Invalid timezone'); }
  if (!Number.isInteger(data.seats) || data.seats < 1 || data.seats > 6) errors.push('Invalid seats');
  return errors;
}

User.prototype.setOnline = async function setOnline(location, hours = 2) {
  const safeHours = Math.max(1 / 60, Math.min(24, Number(hours) || 2));
  this.isOnline = true;
  this.location = cleanLocation(location) || this.location;
  this.onlineUntil = new Date(Date.now() + safeHours * 60 * 60 * 1000);
  this.lastSeenAt = new Date();
  await this.save();
  return this;
};
User.prototype.setOffline = async function setOffline() {
  this.isOnline = false;
  this.onlineUntil = null;
  this.lastSeenAt = new Date();
  await this.save();
  return this;
};
User.getOrCreate = async function getOrCreate(phone) {
  const key = normalizePhone(phone);
  if (!key) throw new Error('A valid phone number is required');
  const [user] = await User.findOrCreate({
    where: { phone: key },
    defaults: { phone: key,...USER_DEFAULTS, lastSeenAt: new Date() },
  });
  if (user.lastSeenAt === null) {
    user.lastSeenAt = new Date();
    await user.save();
  }
  return user;
};

async function initDatabase() {
  await sequelize.authenticate();
  await sequelize.sync({ alter: process.env.DB_ALLOW_ALTER!== 'false' });
  return sequelize;
}
async function createRideSafely(phone, data, transaction = undefined) {
  const input = normalizeRideInput(phone, data);
  const errors = validateRideInput(input);
  if (errors.length) {
    const error = new Error(`Ride validation failed: ${errors.join(', ')}`);
    error.code = 'RIDE_VALIDATION';
    error.details = errors;
    throw error;
  }
  const existing = await RideRequest.findOne({
    where: { phone: input.phone, status: 'OPEN', from: input.from, to: input.to, date: input.date, time: input.time },
    transaction,
  });
  if (existing) return existing;
  return RideRequest.create(input, { transaction });
}
async function claimRideSafely(rideId, driverPhone) {
  const driver = normalizePhone(driverPhone);
  if (!driver) return null;
  const [count] = await RideRequest.update(
    { status: 'TAKEN', driverPhone: driver, takenAt: new Date() },
    { where: { id: rideId, status: 'OPEN', phone: { [Op.ne]: driver } } },
  );
  if (count!== 1) return null;
  return RideRequest.findByPk(rideId);
}
async function completeRideSafely(rideId, actorPhone) {
  const actor = normalizePhone(actorPhone);
  if (!actor) return null;
  const [count] = await RideRequest.update(
    { status: 'COMPLETED', completedAt: new Date() },
    { where: { id: rideId, status: 'TAKEN', [Op.or]: [{ phone: actor }, { driverPhone: actor }] } },
  );
  return count === 1? RideRequest.findByPk(rideId) : null;
}
async function cancelRideSafely(rideId, actorPhone) {
  const actor = normalizePhone(actorPhone);
  if (!actor) return null;
  const [count] = await RideRequest.update(
    { status: 'CANCELLED', cancelledAt: new Date() },
    { where: { id: rideId, status: 'OPEN', phone: actor } },
  );
  return count === 1? RideRequest.findByPk(rideId) : null;
}
async function findUserActiveRide(phone) {
  const key = normalizePhone(phone);
  if (!key) return null;
  return RideRequest.findOne({ where: { status: 'TAKEN', [Op.or]: [{ phone: key }, { driverPhone: key }] }, order: [['updatedAt', 'DESC']] });
}
async function findUserOpenRequests(phone) {
  const key = normalizePhone(phone);
  if (!key) return [];
  return RideRequest.findAll({ where: { phone: key, status: 'OPEN' }, order: [['createdAt', 'DESC']] });
}
async function findMatchingRides(criteria = {}) {
  const where = { status: 'OPEN' };
  if (criteria.date) where.date = criteria.date;
  if (criteria.from) where.from = { [Op.like]: `%${cleanLocation(criteria.from)}%` };
  if (criteria.to) where.to = { [Op.like]: `%${cleanLocation(criteria.to)}%` };
  return RideRequest.findAll({ where, order: [['createdAt', 'DESC']] });
}
async function cleanupDatabase() {
  const now = new Date();
  await RideRequest.update({ status: 'EXPIRED' }, { where: { status: 'OPEN', [Op.or]: [{ expiresAt: { [Op.lte]: now } }, { date: { [Op.lt]: now.toISOString().slice(0, 10) } }] } });
  await RideOffer.update({ status: 'EXPIRED' }, { where: { status: 'ACTIVE', date: { [Op.lt]: now.toISOString().slice(0, 10) } } });
  await User.update({ isOnline: false, onlineUntil: null }, { where: { isOnline: true, onlineUntil: { [Op.lte]: now } } });
  return { expired: 0 };
}

module.exports = {
  sequelize,
  User,
  RideRequest,
  RideOffer,
  Op,
  initDatabase,
  cleanupDatabase,
  createRideSafely,
  claimRideSafely,
  completeRideSafely,
  cancelRideSafely,
  findUserActiveRide,
  findUserOpenRequests,
  findMatchingRides,
  normalizePhone,
  validateRideInput,
};
