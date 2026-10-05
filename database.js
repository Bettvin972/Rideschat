const { Sequelize, DataTypes, Op } = require('sequelize');

const sequelize = new Sequelize(process.env.DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false
    }
  },
  pool: { max: 5, min: 0, acquire: 30000, idle: 10000 }
});

// ================= USERS =================
const User = sequelize.define('User', {
  phone: {
    type: DataTypes.STRING,
    primaryKey: true,
    allowNull: false
  },
  name: {
    type: DataTypes.STRING,
    allowNull: true
  },
  location: {
    type: DataTypes.STRING,
    allowNull: true
  },
  filterFrom: {
    type: DataTypes.STRING,
    allowNull: true
  },
  isOnline: {
    type: DataTypes.BOOLEAN,
    defaultValue: false
  },
  onlineUntil: {
    type: DataTypes.DATE,
    allowNull: true
  },
  rating: {
    type: DataTypes.FLOAT,
    defaultValue: 5
  },
  ratingCount: {
    type: DataTypes.INTEGER,
    defaultValue: 0
  }
}, {
  tableName: 'Users',
  timestamps: true
});

User.getOrCreate = async function(phone) {
  const key = String(phone || '').replace(/[^0-9]/g, '').trim();
  if (!key) throw new Error('Invalid phone for User.getOrCreate');
  const [user] = await User.findOrCreate({
    where: { phone: key },
    defaults: { phone: key, rating: 5, ratingCount: 0, isOnline: false }
  });
  return user;
};

User.prototype.setOnline = async function(location, hours = 2) {
  this.location = location || this.location || 'Main Campus';
  this.isOnline = true;
  this.onlineUntil = new Date(Date.now() + hours * 3600 * 1000);
  await this.save();
  return this;
};

User.prototype.setOffline = async function() {
  this.isOnline = false;
  this.onlineUntil = null;
  this.filterFrom = null;
  await this.save();
  return this;
};

// ================= RIDE REQUESTS =================
const RideRequest = sequelize.define('RideRequest', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true
  },
  phone: {
    type: DataTypes.STRING,
    allowNull: false
  },
  from: {
    type: DataTypes.STRING,
    allowNull: false
  },
  to: {
    type: DataTypes.STRING,
    allowNull: false
  },
  time: {
    type: DataTypes.STRING,
    allowNull: true,
    defaultValue: 'now'
  },
  date: {
    type: DataTypes.STRING,
    allowNull: true
  },
  seats: {
    type: DataTypes.INTEGER,
    defaultValue: 1
  },
  passengerCount: {
    type: DataTypes.INTEGER,
    defaultValue: 1
  },
  status: {
    type: DataTypes.STRING,
    defaultValue: 'OPEN'
  },
  driverPhone: {
    type: DataTypes.STRING,
    allowNull: true
  }
}, {
  tableName: 'RideRequests',
  timestamps: true
});

// FIXES: TypeError: Cannot read properties of undefined (reading 'createCustom')
RideRequest.createCustom = async function(phone, { from, to, time, date, seats }) {
  const cleanPhone = String(phone || '').replace(/[^0-9]/g, '').trim();
  if (!cleanPhone) throw new Error('Invalid phone for RideRequest');
  return await RideRequest.create({
    phone: cleanPhone,
    from: String(from || '').trim().slice(0, 80),
    to: String(to || '').trim().slice(0, 80),
    time: time || 'now',
    date: date || new Date().toISOString().slice(0, 10),
    seats: Number(seats) || 1,
    passengerCount: Number(seats) || 1,
    status: 'OPEN'
  });
};

RideRequest.clearExpired = async function() {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
  await RideRequest.destroy({
    where: {
      status: 'OPEN',
      createdAt: { [Op.lt]: cutoff }
    }
  });
};

// ================= RIDE OFFERS (kept for compatibility) =================
const RideOffer = sequelize.define('RideOffer', {
  id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
  phone: DataTypes.STRING,
  from: DataTypes.STRING,
  to: DataTypes.STRING
}, {
  tableName: 'RideOffers',
  timestamps: true
});

module.exports = { sequelize, User, RideRequest, RideOffer, Op };
