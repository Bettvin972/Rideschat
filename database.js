const { Sequelize, DataTypes, Op } = require('sequelize');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  protocol: 'postgres',
  logging: false,
  dialectOptions: {
    ssl: process.env.DATABASE_URL.includes('render.com')
     ? { require: true, rejectUnauthorized: false }
      : undefined,
  },
  pool: {
    max: Number(process.env.DB_POOL_MAX || 10),
    min: 0,
    acquire: 30000,
    idle: 10000,
  },
  retry: { max: 3 },
});

const User = sequelize.define('User', {
  phone: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
  name: { type: DataTypes.STRING, allowNull: true },
  location: { type: DataTypes.STRING, defaultValue: 'Juja' },
  filterFrom: { type: DataTypes.STRING, allowNull: true },
  isOnline: { type: DataTypes.BOOLEAN, defaultValue: false },
  onlineUntil: { type: DataTypes.DATE, allowNull: true },
  rating: { type: DataTypes.FLOAT, defaultValue: 5.0, allowNull: false },
  ratingCount: { type: DataTypes.INTEGER, defaultValue: 0, allowNull: false },
}, { indexes: [{ fields: ['isOnline', 'onlineUntil'] }, { fields: ['location'] }] });

const RideRequest = sequelize.define('RideRequest', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  phone: { type: DataTypes.STRING, allowNull: false },
  driverPhone: { type: DataTypes.STRING, allowNull: true },
  from: { type: DataTypes.STRING, allowNull: false },
  to: { type: DataTypes.STRING, allowNull: false },
  date: { type: DataTypes.STRING, allowNull: false },
  time: { type: DataTypes.STRING, allowNull: false },
  seats: { type: DataTypes.INTEGER, defaultValue: 1, allowNull: false },
  bags: { type: DataTypes.INTEGER, defaultValue: 0, allowNull: false },
  girls_only: { type: DataTypes.BOOLEAN, defaultValue: false, allowNull: false },
  pool_allowed: { type: DataTypes.BOOLEAN, defaultValue: true, allowNull: false },
  status: { type: DataTypes.STRING, defaultValue: 'OPEN', allowNull: false },
}, { indexes: [{ fields: ['status', 'createdAt'] }, { fields: ['phone', 'status'] }, { fields: ['driverPhone', 'status'] }, { fields: ['date', 'time', 'status'] }] });

const RideOffer = sequelize.define('RideOffer', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  phone: { type: DataTypes.STRING, allowNull: false },
  from: DataTypes.STRING,
  to: DataTypes.STRING,
  date: DataTypes.STRING,
  time: DataTypes.STRING,
  seats: { type: DataTypes.INTEGER, defaultValue: 3 },
  price: { type: DataTypes.INTEGER, defaultValue: 30 },
  rating: { type: DataTypes.FLOAT, defaultValue: 5.0 },
}, { indexes: [{ fields: ['date', 'time'] }, { fields: ['phone'] }] });

function normalizePhone(phone) {
  return String(phone || '').split('@')[0].replace(/[^0-9]/g, '');
}

User.getOrCreate = async (phone) => {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error('Invalid phone number');
  const [user, created] = await User.findOrCreate({
    where: { phone: normalized },
    defaults: { phone: normalized, rating: 5.0, ratingCount: 0 },
  });
  if (created) return user;
  if (user.rating == null) user.rating = 5.0;
  if (user.ratingCount == null) user.ratingCount = 0;
  if (!user.location) user.location = 'Juja';
  await user.save();
  return user;
};

User.prototype.setOnline = async function (loc, hours = 2) {
  this.location = loc || this.location || 'Juja';
  this.isOnline = true;
  const duration = Math.max(1, Math.min(24, Number(hours) || 2));
  this.onlineUntil = new Date(Date.now() + duration * 60 * 60 * 1000);
  await this.save(); return this;
};
User.prototype.setOffline = async function () {
  this.isOnline = false; this.onlineUntil = null;
  await this.save(); return this;
};
User.prototype.addRating = async function (stars) {
  const value = Math.max(1, Math.min(5, Number(stars)));
  if (!this.ratingCount || this.ratingCount < 1) {
    this.rating = value; this.ratingCount = 1;
  } else {
    const total = Number(this.rating || 5) * Number(this.ratingCount);
    this.ratingCount += 1;
    this.rating = (total + value) / this.ratingCount;
  }
  await this.save(); return this.rating;
};
User.clearExpiredOnline = async () => {
  await User.update({ isOnline: false, onlineUntil: null }, { where: { isOnline: true, onlineUntil: { [Op.lte]: new Date() } } });
};

RideRequest.createRide = async (phone, ai) => {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error('Invalid rider phone');
  if (!ai?.from ||!ai?.to ||!ai?.date ||!ai?.time) throw new Error('Ride requires from, to, date and time');

  // Duplicate protection: same rider, same route, OPEN
  const dup = await RideRequest.findOne({ where: { phone: normalized, from: ai.from, to: ai.to, date: ai.date, status: 'OPEN' } });
  if (dup) return dup;

  return RideRequest.create({
    phone: normalized, driverPhone: null,
    from: String(ai.from).trim(), to: String(ai.to).trim(),
    date: String(ai.date).trim(), time: String(ai.time).trim(),
    seats: Math.max(1, Math.min(6, Number(ai.seats) || 1)),
    bags: Math.max(0, Math.min(10, Number(ai.bags) || 0)),
    girls_only: Boolean(ai.girls_only), pool_allowed: ai.pool_allowed!== false,
    status: 'OPEN',
  });
};
RideRequest.createCustom = RideRequest.createRide;

RideRequest.clearExpired = async () => {
  const rides = await RideRequest.findAll({ where: { status: 'OPEN' }, attributes: ['id', 'date', 'time'] });
  const expiredIds = []; const now = new Date();
  for (const ride of rides) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ride.date || ''))) continue;
    if (!/^\d{1,2}:\d{2}$/.test(String(ride.time || ''))) continue;
    const [y, m, d] = ride.date.split('-').map(Number);
    const [h, min] = ride.time.split(':').map(Number);
    const scheduled = new Date(Date.UTC(y, m - 1, d, h, min, 0));
    if (scheduled.getTime() < now.getTime() - 2 * 60 * 60 * 1000) expiredIds.push(ride.id);
  }
  if (expiredIds.length) await RideRequest.destroy({ where: { id: { [Op.in]: expiredIds }, status: 'OPEN' } });
  return expiredIds.length;
};

RideOffer.createOffer = async (phone, ai) => {
  const normalized = normalizePhone(phone);
  return RideOffer.create({
    phone: normalized, from: ai.from, to: ai.to, date: ai.date, time: ai.time,
    seats: Math.max(1, Math.min(6, Number(ai.seats) || 3)),
    price: Number.isFinite(Number(ai.price))? Number(ai.price) : 30,
  });
};
RideOffer.createCustom = RideOffer.createOffer;
RideOffer.clearExpired = async () => 0;

module.exports = { sequelize, User, RideRequest, RideOffer, Op };
