const { Sequelize, DataTypes, Op } = require('sequelize');

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  protocol: 'postgres',
  dialectOptions: {
    ssl: process.env.DATABASE_URL?.includes('render.com')? { require: true, rejectUnauthorized: false } : false
  },
  logging: false
});

const User = sequelize.define('User', {
  phone: { type: DataTypes.STRING, primaryKey: true },
  location: { type: DataTypes.STRING, defaultValue: 'Denton' },
  isOnline: { type: DataTypes.BOOLEAN, defaultValue: false },
  onlineUntil: { type: DataTypes.DATE, allowNull: true },
  rating: { type: DataTypes.FLOAT, defaultValue: 5.0 },
  ratingCount: { type: DataTypes.INTEGER, defaultValue: 1 }
});

const RideRequest = sequelize.define('RideRequest', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  phone: { type: DataTypes.STRING, allowNull: false },
  from: { type: DataTypes.STRING },
  to: { type: DataTypes.STRING },
  date: { type: DataTypes.STRING },
  time: { type: DataTypes.STRING },
  seats: { type: DataTypes.INTEGER, defaultValue: 1 },
  bags: { type: DataTypes.INTEGER, defaultValue: 0 },
  girls_only: { type: DataTypes.BOOLEAN, defaultValue: false },
  pool_allowed: { type: DataTypes.BOOLEAN, defaultValue: true },
  status: { type: DataTypes.STRING, defaultValue: 'OPEN' }
});

const RideOffer = sequelize.define('RideOffer', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  phone: { type: DataTypes.STRING, allowNull: false },
  from: { type: DataTypes.STRING },
  to: { type: DataTypes.STRING },
  date: { type: DataTypes.STRING },
  time: { type: DataTypes.STRING },
  seats: { type: DataTypes.INTEGER, defaultValue: 3 },
  price: { type: DataTypes.INTEGER, defaultValue: 25 },
  rating: { type: DataTypes.FLOAT, defaultValue: 5.0 }
});

sequelize.sync({ alter: true }).then(() => console.log("Rideschat DB Synced"));

User.getOrCreate = async (phone) => {
  let [user] = await User.findOrCreate({ where: { phone } });
  return user;
};
User.prototype.setOnline = async function(loc, hrs) {
  this.location = loc; this.isOnline = true;
  const until = new Date(); until.setHours(until.getHours() + hrs);
  this.onlineUntil = until; await this.save();
};
User.prototype.setOffline = async function() {
  this.isOnline = false; this.onlineUntil = null; await this.save();
};
User.prototype.addRating = async function(stars) {
  let total = this.rating * this.ratingCount;
  this.ratingCount += 1;
  this.rating = (total + stars) / this.ratingCount;
  await this.save();
};
User.getOnlineNearby = async () => {
  return await User.findAll({ where: { isOnline: true, onlineUntil: { [Op.gt]: new Date() } } });
};

RideRequest.createRide = async (phone, ai) => {
  return await RideRequest.create({
    phone, from: ai.from, to: ai.to, date: ai.date, time: ai.time,
    seats: ai.seats || 1, bags: ai.bags || 0,
    girls_only: ai.girls_only || false, pool_allowed: ai.pool_allowed!== false
  });
};
RideRequest.create = RideRequest.createRide;
RideRequest.getNearby = async () => {
  return await RideRequest.findAll({ where: { status: 'OPEN' }, order: [['createdAt','DESC']], limit: 10 });
};
RideRequest.getMatchingRiders = async (offer) => {
  return await RideRequest.findAll({ where: { status: 'OPEN', from: offer.from, to: offer.to, date: offer.date }, limit: 10 });
};
RideRequest.prototype.updateStatus = async function(s) { this.status = s; await this.save(); };

RideOffer.createOffer = async (phone, ai) => {
  const user = await User.findByPk(phone);
  return await RideOffer.create({
    phone, from: ai.from, to: ai.to, date: ai.date, time: ai.time,
    seats: ai.seats || 3, price: 30, rating: user? user.rating : 5.0
  });
};
RideOffer.create = RideOffer.createOffer;
RideOffer.perfectMatch = async (req) => {
  return await RideOffer.findAll({ where: { from: req.from, to: req.to, date: req.date }, limit: 10 });
};

module.exports = { sequelize, User, RideRequest, RideOffer };
