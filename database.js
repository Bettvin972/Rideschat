const { Sequelize, DataTypes, Op } = require('sequelize');
const path = require('path');

const databaseUrl = process.env.DATABASE_URL;

let sequelize;

if (databaseUrl) {
  sequelize = new Sequelize(databaseUrl, {
    dialect: 'postgres',
    logging: false,
    dialectOptions: {
      ssl: process.env.DATABASE_SSL === 'true' || process.env.NODE_ENV === 'production'
        ? { require: true, rejectUnauthorized: false }
        : false,
    },
    pool: {
      max: 15,
      min: 0,
      acquire: 30000,
      idle: 10000,
    },
  });
} else {
  const sqlitePath = path.join(__dirname, 'induU_dev.sqlite');
  sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: sqlitePath,
    logging: false,
  });
}

function normalizePhone(value) {
  if (!value) return '';
  return String(value).split('@')[0].replace(/[^0-9]/g, '');
}

const User = sequelize.define('User', {
  phone: {
    type: DataTypes.STRING,
    primaryKey: true,
    allowNull: false,
    set(value) {
      this.setDataValue('phone', normalizePhone(value));
    },
  },
  name: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  username: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true,
  },
  usernameChangeCount: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    allowNull: false,
  },
  location: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  country: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  timezone: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  rating: {
    type: DataTypes.FLOAT,
    defaultValue: 5.0,
    allowNull: false,
  },
  ratingCount: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    allowNull: false,
  },
  ridesCompleted: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    allowNull: false,
  },
  ridesOffered: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    allowNull: false,
  },
  ridesRequested: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    allowNull: false,
  },
  isOnline: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: false,
  },
  onlineUntil: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  filterFrom: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  lastSeenAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'users',
  timestamps: true,
});

User.getOrCreate = async function (rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (!phone) throw new Error('Cannot get or create user without a valid phone number');

  let [user] = await User.findOrCreate({
    where: { phone },
    defaults: {
      phone,
      username: `user_${phone.slice(-4)}`,
      rating: 5.0,
      ratingCount: 0,
      ridesCompleted: 0,
      ridesOffered: 0,
      ridesRequested: 0,
      isOnline: false,
    },
  });

  return user;
};

User.prototype.setOnline = async function (location = null, hours = 2) {
  const now = new Date();
  const expires = new Date(now.getTime() + hours * 60 * 60 * 1000);

  this.isOnline = true;
  this.onlineUntil = expires;
  if (location) this.location = location;
  this.lastSeenAt = now;

  return this.save();
};

User.prototype.setOffline = async function () {
  this.isOnline = false;
  this.onlineUntil = null;
  this.filterFrom = null;
  this.lastSeenAt = new Date();

  return this.save();
};

User.changeUsernameSafely = async function (rawPhone, requestedUsername, limit = 1) {
  const phone = normalizePhone(rawPhone);
  const cleanUsername = String(requestedUsername || '').trim().replace(/^@+/, '');

  if (!cleanUsername || cleanUsername.length < 3 || cleanUsername.length > 30) {
    return { success: false, message: 'Username must be between 3 and 30 characters.' };
  }

  if (!/^[a-zA-Z0-9_.-]+$/.test(cleanUsername)) {
    return { success: false, message: 'Username can only contain letters, numbers, underscores, dots, and hyphens.' };
  }

  const existing = await User.findOne({ where: { username: cleanUsername } });
  if (existing && existing.phone !== phone) {
    return { success: false, message: 'That username is already taken.' };
  }

  const user = await User.getOrCreate(phone);
  if (Number(user.usernameChangeCount || 0) >= limit) {
    return { success: false, message: `Username can only be changed ${limit} time.` };
  }

  user.username = cleanUsername;
  user.usernameChangeCount = Number(user.usernameChangeCount || 0) + 1;
  await user.save();

  return { success: true, user };
};

const RideRequest = sequelize.define('RideRequest', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  phone: {
    type: DataTypes.STRING,
    allowNull: false,
    set(value) {
      this.setDataValue('phone', normalizePhone(value));
    },
  },
  driverPhone: {
    type: DataTypes.STRING,
    allowNull: true,
    set(value) {
      this.setDataValue('driverPhone', normalizePhone(value));
    },
  },
  from: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  to: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  date: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  time: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  seats: {
    type: DataTypes.INTEGER,
    defaultValue: 1,
    allowNull: false,
  },
  distanceMiles: {
    type: DataTypes.FLOAT,
    allowNull: true,
  },
  extensionCount: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    allowNull: false,
  },
  status: {
    type: DataTypes.ENUM('OPEN', 'TAKEN', 'COMPLETED', 'CANCELLED', 'EXPIRED'),
    defaultValue: 'OPEN',
    allowNull: false,
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
}, {
  tableName: 'ride_requests',
  timestamps: true,
});

RideRequest.createCustom = async function (rawPhone, data) {
  const phone = normalizePhone(rawPhone);
  const ttlMinutes = Number(data.requestTtlMinutes || 30);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

  return RideRequest.create({
    phone,
    from: String(data.from || '').trim(),
    to: String(data.to || '').trim(),
    date: String(data.date || '').trim(),
    time: String(data.time || '').trim(),
    seats: Math.max(1, Math.min(6, Number(data.seats) || 1)),
    distanceMiles: data.distanceMiles != null ? Number(data.distanceMiles) : null,
    status: 'OPEN',
    expiresAt,
  });
};

RideRequest.claimSafely = async function (rideId, rawDriverPhone) {
  const driverPhone = normalizePhone(rawDriverPhone);

  return sequelize.transaction(async (t) => {
    const ride = await RideRequest.findByPk(rideId, { transaction: t, lock: t.LOCK.UPDATE });

    if (!ride) {
      return { success: false, code: 'NOT_FOUND', message: 'Ride request not found' };
    }

    if (normalizePhone(ride.phone) === driverPhone) {
      return { success: false, code: 'SELF', message: 'You cannot claim your own ride request' };
    }

    if (ride.status === 'CANCELLED') {
      return { success: false, code: 'CANCELLED', message: 'This ride request was cancelled by the rider' };
    }

    if (ride.status === 'TAKEN' || ride.driverPhone) {
      return { success: false, code: 'ALREADY_CLAIMED', message: 'This ride request has already been claimed by another driver' };
    }

    if (ride.status === 'EXPIRED' || new Date(ride.expiresAt).getTime() <= Date.now()) {
      ride.status = 'EXPIRED';
      await ride.save({ transaction: t });
      return { success: false, code: 'EXPIRED', message: 'This ride request has expired' };
    }

    if (ride.status !== 'OPEN') {
      return { success: false, code: 'UNAVAILABLE', message: `Ride is not open (status: ${ride.status})` };
    }

    ride.status = 'TAKEN';
    ride.driverPhone = driverPhone;
    await ride.save({ transaction: t });

    return { success: true, ride };
  });
};

RideRequest.extendSafely = async function (rideId, rawRiderPhone, ttlMinutes = 30, maxExtensions = 3) {
  const riderPhone = normalizePhone(rawRiderPhone);

  return sequelize.transaction(async (t) => {
    const ride = await RideRequest.findByPk(rideId, { transaction: t, lock: t.LOCK.UPDATE });

    if (!ride) {
      return { success: false, message: 'Ride request not found' };
    }

    if (normalizePhone(ride.phone) !== riderPhone) {
      return { success: false, message: 'Only the creator of this ride request can extend it' };
    }

    if (ride.status !== 'OPEN') {
      return { success: false, message: `Cannot extend a ride with status: ${ride.status}` };
    }

    if (Number(ride.extensionCount || 0) >= maxExtensions) {
      return { success: false, message: `Maximum extensions reached (${maxExtensions})` };
    }

    const currentExpiry = new Date(ride.expiresAt).getTime();
    const baseTime = Math.max(Date.now(), currentExpiry);
    const newExpiresAt = new Date(baseTime + ttlMinutes * 60 * 1000);

    ride.expiresAt = newExpiresAt;
    ride.extensionCount = Number(ride.extensionCount || 0) + 1;
    await ride.save({ transaction: t });

    return { success: true, ride };
  });
};

RideRequest.cancelSafely = async function (rideId, rawRiderPhone) {
  const riderPhone = normalizePhone(rawRiderPhone);

  return sequelize.transaction(async (t) => {
    const ride = await RideRequest.findByPk(rideId, { transaction: t, lock: t.LOCK.UPDATE });

    if (!ride) {
      return { success: false, message: 'Ride request not found' };
    }

    if (normalizePhone(ride.phone) !== riderPhone) {
      return { success: false, message: 'Only the creator of this ride request can cancel it' };
    }

    if (ride.status === 'CANCELLED') {
      return { success: false, message: 'Ride request is already cancelled' };
    }

    if (ride.status === 'COMPLETED') {
      return { success: false, message: 'Cannot cancel a completed ride' };
    }

    ride.status = 'CANCELLED';
    await ride.save({ transaction: t });

    return { success: true, ride };
  });
};

RideRequest.completeSafely = async function (rideId, rawUserPhone) {
  const userPhone = normalizePhone(rawUserPhone);

  return sequelize.transaction(async (t) => {
    const ride = await RideRequest.findByPk(rideId, { transaction: t, lock: t.LOCK.UPDATE });

    if (!ride) {
      return { success: false, message: 'Ride request not found' };
    }

    const isRider = normalizePhone(ride.phone) === userPhone;
    const isDriver = normalizePhone(ride.driverPhone) === userPhone;

    if (!isRider && !isDriver) {
      return { success: false, message: 'Only the rider or driver of this trip can mark it completed' };
    }

    if (ride.status === 'COMPLETED') {
      return { success: false, message: 'Trip is already marked as completed' };
    }

    if (ride.status !== 'TAKEN') {
      return { success: false, message: `Cannot complete a trip with status: ${ride.status}` };
    }

    ride.status = 'COMPLETED';
    await ride.save({ transaction: t });

    if (ride.phone) {
      const rider = await User.getOrCreate(ride.phone);
      rider.ridesCompleted = Number(rider.ridesCompleted || 0) + 1;
      await rider.save({ transaction: t });
    }

    if (ride.driverPhone) {
      const driver = await User.getOrCreate(ride.driverPhone);
      driver.ridesCompleted = Number(driver.ridesCompleted || 0) + 1;
      await driver.save({ transaction: t });
    }

    return { success: true, ride };
  });
};

const RideOffer = sequelize.define('RideOffer', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  phone: {
    type: DataTypes.STRING,
    allowNull: false,
    set(value) {
      this.setDataValue('phone', normalizePhone(value));
    },
  },
  from: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  to: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  date: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  time: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  seatsAvailable: {
    type: DataTypes.INTEGER,
    defaultValue: 1,
    allowNull: false,
  },
  status: {
    type: DataTypes.ENUM('OPEN', 'CANCELLED', 'EXPIRED'),
    defaultValue: 'OPEN',
    allowNull: false,
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
}, {
  tableName: 'ride_offers',
  timestamps: true,
});

async function initDatabase() {
  await sequelize.authenticate();
  await sequelize.sync({ alter: true });
}

async function cleanupDatabase(ttlMinutes = 30) {
  const now = new Date();

  await RideRequest.update(
    { status: 'EXPIRED' },
    {
      where: {
        status: 'OPEN',
        expiresAt: { [Op.lte]: now },
      },
    }
  );

  await RideOffer.update(
    { status: 'EXPIRED' },
    {
      where: {
        status: 'OPEN',
        expiresAt: { [Op.lte]: now },
      },
    }
  );

  await User.update(
    { isOnline: false, onlineUntil: null, filterFrom: null },
    {
      where: {
        isOnline: true,
        onlineUntil: { [Op.lte]: now },
      },
    }
  );
}

module.exports = {
  sequelize,
  User,
  RideRequest,
  RideOffer,
  initDatabase,
  cleanupDatabase,
};
