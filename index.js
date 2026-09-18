const express = require("express")
const app = express()
app.use(express.json())
const cors = require("cors")
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb')
const cloudinary = require('cloudinary').v2
const cron = require("node-cron")
require('dotenv').config()
const dns = require("dns")

if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    try {
        dns.setServers(["8.8.8.8", "1.1.1.1"])
    } catch (e) {
        console.log("DNS setServers warning:", e.message)
    }
}


app.use(cors())

const port = process.env.PORT || 5000

app.get("/", (req, res) => {
    res.send("Miami Beach Resort server is running")
})

const admin = require("firebase-admin")
if (process.env.FB_SERVICE_KEY) {
    try {
        const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString('utf-8')
        const serviceAccount = JSON.parse(decoded)
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        })
    } catch (e) {
        console.log("Firebase Admin init error:", e.message)
    }
}

// cloudinary config
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
})

// Helper to extract Cloudinary public ID from URL or existing ID string
const extractCloudinaryPublicId = (urlOrId) => {
    if (!urlOrId || typeof urlOrId !== 'string') return null
    const trimmed = urlOrId.trim()
    if (!trimmed) return null
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
        return trimmed.replace(/\.[^/.]+$/, "")
    }
    const match = trimmed.match(/\/upload\/(?:v\d+\/)?([^\.\?\#]+)/)
    return match ? match[1] : null
}

// Helper to collect all unique Cloudinary public IDs from a category or room document/payload
const collectCloudinaryPublicIds = (doc) => {
    if (!doc || typeof doc !== 'object') return []
    const ids = new Set()
    const addId = (val) => {
        const extracted = extractCloudinaryPublicId(val)
        if (extracted) ids.add(extracted)
    }

    if (doc.imagePublicId) addId(doc.imagePublicId)
    if (doc.imageUrl) addId(doc.imageUrl)
    if (doc.image) addId(doc.image)

    if (Array.isArray(doc.images)) {
        doc.images.forEach(img => {
            if (typeof img === 'string') {
                addId(img)
            } else if (img && typeof img === 'object') {
                if (img.publicId) addId(img.publicId)
                if (img.url) addId(img.url)
            }
        })
    }
    return Array.from(ids)
}


// mongodb
const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@cluster0.7hhwads.mongodb.net/?appName=Cluster0`

let client = null
let db = null

function getDatabase() {
    if (!client || (client.topology && (client.topology.isDestroyed?.() || client.topology.isClosed?.()))) {
        client = new MongoClient(uri, {
            serverApi: {
                version: ServerApiVersion.v1,
                strict: true,
                deprecationErrors: true,
            }
        })
        db = client.db("miami_beach_resort_db")
    }
    return db
}

const getCollection = (name) => {
    return new Proxy({}, {
        get(target, prop) {
            const database = getDatabase()
            const col = database.collection(name)
            const value = col[prop]
            if (typeof value === 'function') {
                return value.bind(col)
            }
            return value
        }
    })
}

const generateBookingId = () => {
    const random = Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, "0")
    return `BK-${random}`
}

const NO_TRANSACTION_ID_METHODS = [
    "cash",
    "other",
    "pay on arrival",
    "pay on arrival / unpaid",
    "pending",
    "unpaid"
]

const isDigitalPaymentMethod = (method) => {
    if (!method) return false
    const clean = String(method).trim().toLowerCase()
    return !NO_TRANSACTION_ID_METHODS.includes(clean)
}

const BOOKING_STATUS = {
    REQUEST_BOOKING: "request_booking",
    BOOKING_CONFIRMED: "booking_confirmed",
    CHECKED_IN: "checked_id",
    CHECKED_OUT: "checked_out",
    CANCEL: "cancel"
}

const ACTIVE_BOOKING_STATUSES = [
    BOOKING_STATUS.REQUEST_BOOKING,
    BOOKING_STATUS.BOOKING_CONFIRMED,
    BOOKING_STATUS.CHECKED_IN,
    "pending",
    "confirmed"
]

const REQUEST_BOOKING_EXPIRE_HOURS_BY_ROLE = {
    user: 1,
    admin: 1,
    default: 1
}

const getRequestBookingExpireHours = (role = "default") => {
    return REQUEST_BOOKING_EXPIRE_HOURS_BY_ROLE[role] || REQUEST_BOOKING_EXPIRE_HOURS_BY_ROLE.default
}

const ensureBookingIdIndex = async (bookingCollection) => {
    const indexes = await bookingCollection.indexes()
    const bookingIdIndex = indexes.find(index => index.key?.bookingId === 1)
    if (!bookingIdIndex?.unique) {
        await bookingCollection.createIndex({ bookingId: 1 }, { unique: true })
    }

    const statusIndex = indexes.find(index => index.key?.status === 1)
    if (!statusIndex) {
        await bookingCollection.createIndex({ status: 1 })
    }

    const roomCheckInIndex = indexes.find(index => index.key?.["rooms.checkIn"] === 1)
    if (!roomCheckInIndex) {
        await bookingCollection.createIndex({ "rooms.checkIn": 1 })
    }

    const roomCheckOutIndex = indexes.find(index => index.key?.["rooms.checkOut"] === 1)
    if (!roomCheckOutIndex) {
        await bookingCollection.createIndex({ "rooms.checkOut": 1 })
    }
}

const toObjectId = (value) => {
    try {
        return ObjectId.isValid(value) ? new ObjectId(value) : null
    } catch (_) {
        return null
    }
}

const getNightCount = (checkIn, checkOut) => {
    const nights = Math.ceil((new Date(checkOut) - new Date(checkIn)) / (1000 * 60 * 60 * 24))
    return nights > 0 ? nights : 0
}

const getBookingRooms = (booking = {}) => {
    if (Array.isArray(booking.rooms) && booking.rooms.length) {
        return booking.rooms.map(r => ({
            ...r,
            nights: Number(r.nights) || getNightCount(r.checkIn || booking.checkIn, r.checkOut || booking.checkOut) || 1
        }))
    }

    if (!booking.roomId && !booking.checkIn && !booking.checkOut) {
        return []
    }

    return [{
        roomId: booking.roomId,
        categoryId: booking.categoryId,
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
        adults: Number(booking.adults || 1),
        babies: Number(booking.babies || 0),
        pricePerNight: Number(booking.pricePerNight || booking.price || 0),
        nights: getNightCount(booking.checkIn, booking.checkOut) || 1,
        room: {
            name: booking.roomName,
            category: booking.roomCategory
        }
    }]
}

const normalizeBookingRooms = (data = {}) => {
    const rawRooms = Array.isArray(data.rooms) && data.rooms.length
        ? data.rooms
        : [{
            roomId: data.roomId || data.categoryId,
            categoryId: data.categoryId,
            categoryName: data.categoryName,
            roomNo: data.roomNo,
            checkIn: data.checkIn,
            checkOut: data.checkOut,
            adults: data.adults,
            babies: data.babies,
            pricePerNight: data.pricePerNight || data.price,
            nights: data.nights
        }]

    return rawRooms.map(room => {
        const checkIn = room.checkIn || data.checkIn
        const checkOut = room.checkOut || data.checkOut
        const nights = Number(room.nights) || getNightCount(checkIn, checkOut) || 1
        return {
            roomId: String(room.roomId || room.categoryId || ""),
            categoryId: room.categoryId ? String(room.categoryId) : (room.roomId ? String(room.roomId) : ""),
            categoryName: String(room.categoryName || "").replace(/[\u200B-\u200D\uFEFF]/g, '').trim(),
            roomNo: room.roomNo || "",
            checkIn: checkIn,
            checkOut: checkOut,
            adults: Number(room.adults || 0),
            babies: Number(room.babies || 0),
            pricePerNight: Number(room.pricePerNight || 0),
            nights: nights
        }
    })
}

const getRoomTotal = (room = {}) => {
    return getNightCount(room.checkIn, room.checkOut) * Number(room.pricePerNight || 0)
}

const getBookingSubtotal = (booking = {}) => {
    const extraCost = Number(
        booking.extraServiceCost ||
        (Array.isArray(booking.extraServices)
            ? booking.extraServices.reduce((sum, s) => sum + Number(s.totalCost || (Number(s.unitPrice || 0) * Number(s.quantity || 1)) || 0), 0)
            : booking.extraServices?.totalCost) ||
        0
    )
    const rooms = getBookingRooms(booking)
    if (rooms.length) {
        const total = rooms.reduce((sum, room) => sum + getRoomTotal(room), 0)
        if (total > 0) return total + extraCost
    }
    const base = Number(booking.subtotal || booking.standardTotal || booking.totalAmount || 0)
    return base > 0 ? base + extraCost : 0
}

const getBookingDiscount = (booking = {}) => {
    return Number(booking.discountAmount || booking.discount || booking.specialDiscount || 0)
}

const getBookingTotal = (booking = {}) => {
    const subtotal = getBookingSubtotal(booking)
    const discount = getBookingDiscount(booking)

    return Math.max(0, subtotal - discount)
}

const getBookingPaidAmount = (booking = {}) => {
    return Number(booking.paidAmount !== undefined && booking.paidAmount !== null ? booking.paidAmount : (booking.advanceAmount || 0))
}

const getBookingDueAmount = (booking = {}) => {
    const payableTotal = getBookingTotal(booking)
    const paid = getBookingPaidAmount(booking)
    return Math.max(0, payableTotal - paid)
}

const CONFIRMED_STATUSES = [
    BOOKING_STATUS.BOOKING_CONFIRMED,
    BOOKING_STATUS.CHECKED_IN,
    BOOKING_STATUS.CHECKED_OUT,
    "booking_confirmed",
    "checked_id",
    "checked_in",
    "checked_out",
    "confirmed"
]

const CANCEL_STATUSES = [
    BOOKING_STATUS.CANCEL,
    "cancel",
    "cancelled"
]

const isRevenueBooking = (booking = {}) => {
    if (CONFIRMED_STATUSES.includes(booking.status)) return true
    if (CANCEL_STATUSES.includes(booking.status) && Number(booking.paidAmount || 0) > 0) return true
    return false
}

const getBookingRevenue = (booking = {}) => {
    if (CANCEL_STATUSES.includes(booking.status)) {
        return Number(booking.paidAmount || 0)
    }
    if (CONFIRMED_STATUSES.includes(booking.status)) {
        return getBookingTotal(booking)
    }
    return 0
}

const getRoomIdsForLookup = (bookings = []) => {
    return [...new Set(bookings.flatMap(booking => getBookingRooms(booking).map(room => room.roomId).filter(Boolean)))]
}

const hydrateBookingsWithRooms = async (bookings = [], roomCollection, categoryAndRoomCollection) => {
    const roomIds = getRoomIdsForLookup(bookings)
    const objectIds = roomIds.map(toObjectId).filter(Boolean)
    const [roomDocs, categoryDocs] = await Promise.all([
        objectIds.length ? roomCollection.find({ _id: { $in: objectIds } }).toArray() : [],
        objectIds.length && categoryAndRoomCollection ? categoryAndRoomCollection.find({ _id: { $in: objectIds } }).toArray() : []
    ])
    const docMap = new Map()
    categoryDocs.forEach(c => docMap.set(String(c._id), { name: c.name, category: c.name, price: c.price, ...c }))
    roomDocs.forEach(r => docMap.set(String(r._id), { name: r.name, category: r.category, price: r.price, ...r }))

    return bookings.map(booking => {
        const rooms = getBookingRooms(booking).map(room => {
            const lookupId = String(room.categoryId || room.roomId || "")
            const matched = docMap.get(lookupId) || room.room || null
            const rawCat = room.categoryName || matched?.name || matched?.category || "Category Room"
            const cleanCat = String(rawCat).replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
            return {
                ...room,
                categoryName: cleanCat,
                room: matched || room.room || null
            }
        })
        return {
            ...booking,
            rooms,
            calculatedTotalAmount: getBookingTotal({ ...booking, rooms })
        }
    })
}

const findRoomConflict = async (bookingCollection, room) => {
    const roomId = String(room.roomId || "")
    const objectId = toObjectId(roomId)
    const legacyRoomFilters = [{ roomId }]
    if (objectId) legacyRoomFilters.push({ roomId: objectId })

    return bookingCollection.findOne({
        status: { $in: ACTIVE_BOOKING_STATUSES },
        $or: [
            {
                rooms: {
                    $elemMatch: {
                        roomId,
                        checkIn: { $lt: room.checkOut },
                        checkOut: { $gt: room.checkIn }
                    }
                }
            },
            {
                $and: [
                    { $or: legacyRoomFilters },
                    { checkIn: { $lt: room.checkOut } },
                    { checkOut: { $gt: room.checkIn } }
                ]
            }
        ]
    })
}

const validateBookingRooms = (rooms = []) => {
    if (!rooms.length) return "At least one room is required"

    for (const room of rooms) {
        if (!room.roomId && !room.categoryId) return "Room or Category is required"
        if (!room.checkIn || !room.checkOut) return "Check-in and Check-out dates are required for every room"
        if (new Date(room.checkOut) <= new Date(room.checkIn)) return "Check-out date must be after check-in date"
        if (Number(room.adults || 0) < 1) return "Every room needs at least one adult"
    }

    for (let i = 0; i < rooms.length; i++) {
        for (let j = i + 1; j < rooms.length; j++) {
            const first = rooms[i]
            const second = rooms[j]
            // Only block if a specific physical roomNo is specified and identical for overlapping dates
            if (first.roomNo && second.roomNo && first.roomNo === second.roomNo && first.checkIn < second.checkOut && first.checkOut > second.checkIn) {
                return `Room ${first.roomNo} cannot be selected twice for overlapping dates`
            }
        }
    }

    return ""
}

const startRequestBookingAutoCancelJob = (bookingCollection) => {
    cron.schedule("* * * * *", async () => {
        const now = new Date()

        try {
            await bookingCollection.updateMany(
                {
                    status: BOOKING_STATUS.REQUEST_BOOKING,
                    requestExpiresAt: { $lte: now }
                },
                {
                    $set: {
                        status: BOOKING_STATUS.CANCEL,
                        cancelledAt: now,
                        cancelReason: "Request booking expired after waiting time"
                    },
                    $push: {
                        statusHistory: {
                            status: BOOKING_STATUS.CANCEL,
                            time: now,
                            note: "Auto cancelled by cron after request booking expired"
                        }
                    }
                }
            )
        } catch (error) {
            console.log("Request booking auto cancel error:", error.message)
        }
    })
}

// collections
const userCollection = getCollection("users")
const roomCollection = getCollection("rooms")
const bookingCollection = getCollection("bookings")
const categoryAndRoomCollection = getCollection("categoryandroom")
const outOfOrderCollection = getCollection("out_of_order")
const extraServicesCollection = getCollection("extra_services")
const settingsCollection = getCollection("settings")

const getTodayDateStr = () => {
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date())
    } catch (e) {
        return new Date().toISOString().split('T')[0]
    }
}

const applyDuePriceSchedules = async (targetCategoryId = null) => {
    try {
        const todayStr = getTodayDateStr()
        let query
        if (targetCategoryId) {
            const catId = toObjectId(targetCategoryId) || targetCategoryId
            query = {
                _id: catId,
                scheduledPrices: { $elemMatch: { effectiveDate: { $lte: todayStr } } }
            }
        } else {
            query = {
                scheduledPrices: { $elemMatch: { effectiveDate: { $lte: todayStr } } }
            }
        }

        const categories = await categoryAndRoomCollection.find(query).toArray()
        if (!categories || categories.length === 0) return

        for (const cat of categories) {
            const scheduledPrices = Array.isArray(cat.scheduledPrices) ? cat.scheduledPrices : []
            const dueSchedules = scheduledPrices
                .filter(sp => sp && sp.effectiveDate && sp.effectiveDate <= todayStr)
                .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))

            if (dueSchedules.length === 0) continue

            const remainingSchedules = scheduledPrices.filter(sp => !sp || !sp.effectiveDate || sp.effectiveDate > todayStr)

            let currentPrice = Number(cat.price || 0)
            const newHistoryEntries = []

            for (const sp of dueSchedules) {
                const targetPrice = Number(sp.price)
                if (!isNaN(targetPrice)) {
                    newHistoryEntries.push({
                        id: sp.id || Math.random().toString(36).slice(2, 9),
                        previousPrice: currentPrice,
                        newPrice: targetPrice,
                        effectiveDate: sp.effectiveDate,
                        note: sp.note || "",
                        appliedAt: new Date()
                    })
                    currentPrice = targetPrice
                }
            }

            const updateOps = {
                $set: {
                    price: currentPrice,
                    scheduledPrices: remainingSchedules,
                    updatedAt: new Date()
                }
            }

            if (newHistoryEntries.length > 0) {
                updateOps.$push = {
                    priceHistory: { $each: newHistoryEntries }
                }
            }

            await categoryAndRoomCollection.updateOne({ _id: cat._id }, updateOps)
        }
    } catch (err) {
        console.error("applyDuePriceSchedules error:", err)
    }
}

// Initialize indexes and cron in background without blocking startup / route registration
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    ensureBookingIdIndex(bookingCollection).catch(err => console.log("Index init error:", err.message))
    startRequestBookingAutoCancelJob(bookingCollection)
    cron.schedule("*/5 * * * *", () => {
        applyDuePriceSchedules().catch(e => console.log("Cron price schedule check error:", e.message))
    })
    applyDuePriceSchedules().catch(e => console.log("Startup price schedule check error:", e.message))
}

// Firebase JWT (ID Token) verification middleware
const verifyFBToken = async (req, res, next) => {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).send({ message: "Unauthorized access: No token provided" })
    }
    const token = authHeader.split(" ")[1]
    try {
        const decodedUser = await admin.auth().verifyIdToken(token)
        req.user = decodedUser
        req.decodedEmail = decodedUser.email
        req.decodedUid = decodedUser.uid
        next()
    } catch (error) {
        console.error("Token verification failed:", error.message)
        return res.status(401).send({ message: "Unauthorized access: Invalid or expired token" })
    }
}

// Admin role verification middleware
const verifyAdmin = async (req, res, next) => {
    const email = req.decodedEmail
    if (!email) {
        return res.status(403).send({ message: "Forbidden access: No verified user email" })
    }
    const user = await userCollection.findOne({ email: { $regex: `^${email}$`, $options: "i" } })
    if (user?.role !== "admin") {
        return res.status(403).send({ message: "Forbidden access: Admin access required" })
    }
    next()
}

// Strict Admin Only middleware for critical operations (e.g. Delete Category)
const verifyAdminOnly = async (req, res, next) => {
    const email = req.decodedEmail
    if (!email) {
        return res.status(403).send({ message: "Forbidden: No verified user email" })
    }
    const user = await userCollection.findOne({ email: { $regex: `^${email}$`, $options: "i" } })
    if (user?.role !== "admin") {
        return res.status(403).send({ message: "Forbidden: Only Admin can perform this action." })
    }
    next()
}

// Strict Admin or Manager middleware for room maintenance operations (Out of Order)
const verifyAdminOrManager = async (req, res, next) => {
    const email = req.decodedEmail
    if (!email) {
        return res.status(403).send({ message: "Forbidden: No verified user email" })
    }
    const user = await userCollection.findOne({ email: { $regex: `^${email}$`, $options: "i" } })
    const role = String(user?.role || '').trim().toLowerCase()
    if (!["admin", "manager"].includes(role)) {
        return res.status(403).send({ message: "Forbidden: Only Admin or Manager can modify Out of Order status." })
    }
    next()
}


// USER RELATED CODES ..............................................
app.post("/users", async (req, res) => {
    const data = req.body
    const query = { email: { $regex: `^${data.email}$`, $options: "i" } }
    const userExists = await userCollection.findOne(query)
    if (userExists) {
        return res.send({ message: "User Exists" })
    }
    data.role = data.role || "user"
    data.created_At = new Date()
    data.lastActiveAt = new Date()
    const result = await userCollection.insertOne(data)
    res.send(result)
})

app.patch("/users/last-active", async (req, res) => {
    const { uid } = req.body
    const update = { $set: { lastActiveAt: new Date() } }
    const result = await userCollection.updateOne({ uid }, update)
    res.send(result)
})

app.get("/user", verifyFBToken, async (req, res) => {
    const { uid, email } = req.query
    let query = {}
    if (uid) query.uid = uid
    else if (email) query.email = { $regex: `^${email}$`, $options: "i" }
    const result = await userCollection.findOne(query)
    res.send(result)
})

app.get("/role/:email", verifyFBToken, async (req, res) => {
    const { email } = req.params
    const options = { projection: { role: 1, _id: 0 } }
    const result = await userCollection.findOne({ email: { $regex: `^${email}$`, $options: "i" } }, options)
    res.send({ role: result?.role || "user" })
})

app.patch("/user/:id", verifyFBToken, async (req, res) => {
    const { id } = req.params
    const data = req.body
    const query = { _id: new ObjectId(id) }

    // If updating role, ensure requester is admin and cannot modify self
    if (data.role) {
        const requesterEmail = req.decodedEmail || req.headers['x-user-email']
        const requesterUid = req.decodedUid

        let adminUser = null
        if (requesterEmail) {
            adminUser = await userCollection.findOne({ email: { $regex: `^${requesterEmail}$`, $options: "i" } })
        } else if (requesterUid) {
            adminUser = await userCollection.findOne({ uid: requesterUid })
        }

        // if (!adminUser || adminUser.role !== "admin") {
        //     return res.status(403).send({ message: "Only administrators can modify roles" })
        // }

        const targetUser = await userCollection.findOne(query)
        if (targetUser && requesterEmail && targetUser.email?.toLowerCase() === requesterEmail.toLowerCase()) {
            return res.status(400).send({ message: "You cannot modify your own role" })
        }
    } else {
        data.updatedAt = new Date()
    }

    const update = { $set: data }
    const result = await userCollection.updateOne(query, update)
    res.send(result)
})

// all users for admin with workflow metrics
app.get("/users", verifyFBToken, verifyAdmin, async (req, res) => {
    const { search, role } = req.query
    const query = {}
    if (search) {
        query.$or = [
            { name: { $regex: search, $options: "i" } },
            { email: { $regex: search, $options: "i" } },
            { phone: { $regex: search, $options: "i" } }
        ]
    }
    if (role && role !== "all") {
        if (role === "user") {
            const userRoleConditions = [
                { role: "user" },
                { role: { $exists: false } },
                { role: null },
                { role: "" }
            ]
            if (query.$or) {
                query.$and = [{ $or: query.$or }, { $or: userRoleConditions }]
                delete query.$or
            } else {
                query.$or = userRoleConditions
            }
        } else {
            query.role = role
        }
    }
    const users = await userCollection.find(query).sort({ _id: -1 }).toArray()
    const allBookings = await bookingCollection.find().toArray()

    const enrichedUsers = users.map(u => {
        const uEmail = String(u.email || "").trim().toLowerCase()
        const uName = String(u.name || "").trim().toLowerCase()
        const uUid = String(u.uid || "").trim()

        const userBookings = allBookings.filter(b => {
            const ref = String(b.reference || "").trim().toLowerCase()
            const bEmail = String(b.userEmail || b.email || b.bookedBy?.email || b.createdBy?.email || "").trim().toLowerCase()
            const bName = String(b.bookedBy?.name || b.createdBy?.name || "").trim().toLowerCase()
            const bBookedUid = String(b.bookedBy?.uid || b.createdBy?.uid || "").trim()

            if (uUid && bBookedUid && bBookedUid === uUid) return true
            if (uEmail && (ref === uEmail || bEmail === uEmail || ref.includes(uEmail))) return true
            if (uName && uName.length >= 2 && (ref === uName || bName === uName || ref.includes(uName))) return true
            return false
        })

        const confirmedBookings = userBookings.filter(isRevenueBooking)

        const totalSales = confirmedBookings.reduce((sum, b) => sum + getBookingRevenue(b), 0)
        const totalPaid = confirmedBookings.reduce((sum, b) => sum + Number(b.paidAmount || 0), 0)
        const totalDue = Math.max(0, totalSales - totalPaid)

        return {
            ...u,
            stats: {
                totalBookings: userBookings.length,
                confirmedBookings: confirmedBookings.length,
                pendingBookings: userBookings.filter(b => [BOOKING_STATUS.REQUEST_BOOKING, "pending"].includes(b.status)).length,
                cancelledBookings: userBookings.filter(b => [BOOKING_STATUS.CANCEL, "cancelled"].includes(b.status)).length,
                totalSales,
                totalPaid,
                totalDue,
                lastBookingDate: userBookings.length ? userBookings.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0].createdAt : null
            }
        }
    })

    res.send(enrichedUsers)
})

// Detailed user workflow & activity breakdown for Admin
app.get("/admin/user-workflow/:userId", verifyFBToken, verifyAdmin, async (req, res) => {
    try {
        const { userId } = req.params
        const query = toObjectId(userId) ? { _id: toObjectId(userId) } : { uid: userId }
        let targetUser = await userCollection.findOne(query)

        if (!targetUser) {
            targetUser = await userCollection.findOne({ email: { $regex: `^${userId}$`, $options: "i" } })
        }

        if (!targetUser) {
            return res.status(404).send({ message: "User not found" })
        }

        const uEmail = String(targetUser.email || "").trim().toLowerCase()
        const uName = String(targetUser.name || "").trim().toLowerCase()
        const uUid = String(targetUser.uid || "").trim()

        const allBookings = await bookingCollection.find().sort({ _id: -1 }).toArray()
        const hydratedBookings = await hydrateBookingsWithRooms(allBookings, roomCollection, categoryAndRoomCollection)

        const userBookings = hydratedBookings.filter(b => {
            const ref = String(b.reference || "").trim().toLowerCase()
            const bEmail = String(b.userEmail || b.email || b.bookedBy?.email || b.createdBy?.email || "").trim().toLowerCase()
            const bName = String(b.bookedBy?.name || b.createdBy?.name || "").trim().toLowerCase()
            const bBookedUid = String(b.bookedBy?.uid || b.createdBy?.uid || "").trim()

            if (uUid && bBookedUid && bBookedUid === uUid) return true
            if (uEmail && (ref === uEmail || bEmail === uEmail || ref.includes(uEmail))) return true
            if (uName && uName.length >= 2 && (ref === uName || bName === uName || ref.includes(uName))) return true
            return false
        })

        const confirmedBookings = userBookings.filter(isRevenueBooking)

        const totalSales = confirmedBookings.reduce((sum, b) => sum + getBookingRevenue(b), 0)
        const totalPaid = confirmedBookings.reduce((sum, b) => sum + Number(b.paidAmount || 0), 0)
        const totalDue = Math.max(0, totalSales - totalPaid)

        // Activity logs performed by this user
        const activityLogs = []
        allBookings.forEach(b => {
            if (Array.isArray(b.statusHistory)) {
                b.statusHistory.forEach(hist => {
                    const act = hist.changedBy || {}
                    const actUid = String(act.uid || "").trim()
                    if ((uUid && actUid && actUid === uUid) || (uEmail && act.email?.toLowerCase() === uEmail) || (uName && act.name?.toLowerCase() === uName)) {
                        activityLogs.push({
                            type: "status_change",
                            bookingId: b.bookingId,
                            bookingDbId: b._id,
                            guestName: b.name,
                            status: hist.status,
                            time: hist.time,
                            note: hist.note
                        })
                    }
                })
            }
            if (Array.isArray(b.paymentHistory)) {
                b.paymentHistory.forEach(pay => {
                    const col = pay.collectedBy || {}
                    const colUid = String(col.uid || "").trim()
                    if ((uUid && colUid && colUid === uUid) || (uEmail && col.email?.toLowerCase() === uEmail) || (uName && col.name?.toLowerCase() === uName)) {
                        activityLogs.push({
                            type: "payment_collection",
                            bookingId: b.bookingId,
                            bookingDbId: b._id,
                            guestName: b.name,
                            amount: pay.amount,
                            method: pay.paymentMethod,
                            time: pay.date,
                            note: pay.note,
                            transactionId: pay.transactionId
                        })
                    }
                })
            }
        })

        res.send({
            user: targetUser,
            metrics: {
                totalBookings: userBookings.length,
                confirmedBookings: confirmedBookings.length,
                pendingBookings: userBookings.filter(b => [BOOKING_STATUS.REQUEST_BOOKING, "pending"].includes(b.status)).length,
                cancelledBookings: userBookings.filter(b => [BOOKING_STATUS.CANCEL, "cancelled"].includes(b.status)).length,
                totalSales,
                totalPaid,
                totalDue,
            },
            bookings: userBookings,
            activities: activityLogs.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))
        })
    } catch (err) {
        console.error("User workflow fetch error:", err)
        res.status(500).send({ message: "Failed to load user workflow details" })
    }
})


// ROOM RELATED CODES ..............................................
app.get("/rooms", async (req, res) => {
    const { status, skip, limit } = req.query
    let query = {}
    if (status) query.status = status
    const result = await roomCollection
        .find(query)
        .sort({ _id: -1 })
        .skip(Number(skip) || 0)
        .limit(Number(limit) || 0)
        .toArray()
    if (skip || limit) {
        const totalDataCount = await roomCollection.countDocuments(query)
        res.send({ result, totalDataCount })
        return
    }
    res.send(result)
})

app.get("/room/:id", async (req, res) => {
    const { id } = req.params
    const query = toObjectId(id) ? { _id: toObjectId(id) } : { _id: id }
    let result = await categoryAndRoomCollection.findOne(query)
    if (!result) {
        result = await roomCollection.findOne(query)
    }
    if (!result) {
        return res.status(404).send({ message: "Room or Category not found" })
    }
    res.send(result)
})

app.post("/rooms", async (req, res) => {
    const data = req.body
    data.createdAt = new Date()
    data.status = data.status || "active"
    const result = await roomCollection.insertOne(data)
    res.send(result)
})

app.patch("/room/:id", async (req, res) => {
    const { id } = req.params
    const data = req.body
    const query = { _id: new ObjectId(id) }
    data.updatedAt = new Date()
    const update = { $set: data }
    const result = await roomCollection.updateOne(query, update)
    res.send(result)
})

app.delete("/room/:id", async (req, res) => {
    const { id } = req.params
    const query = toObjectId(id) ? { _id: toObjectId(id) } : { _id: id }
    // get the room to find all cloudinary public_ids before deleting
    const room = await roomCollection.findOne(query)

    if (room) {
        const publicIdsToDelete = collectCloudinaryPublicIds(room)
        await Promise.all(publicIdsToDelete.map(async (pId) => {
            try {
                await cloudinary.uploader.destroy(pId)
            } catch (err) {
                console.log("Cloudinary delete error for room image", pId, ":", err.message)
            }
        }))
    }

    const result = await roomCollection.deleteOne(query)
    res.send(result)
})


// BOOKING RELATED CODES ..............................................
// Check live room availability for specific dates
app.get("/check-room-availability", async (req, res) => {
    const { roomId, checkIn, checkOut } = req.query
    if (!checkIn || !checkOut) {
        return res.status(400).send({ available: false, message: "Check-in and Check-out dates are required" })
    }
    if (!roomId) {
        return res.status(400).send({ available: false, message: "Room is required" })
    }

    // 1. Check Out of Order maintenance status
    const roomDoc = toObjectId(roomId) ? await roomCollection.findOne({ _id: toObjectId(roomId) }) : null
    const roomNo = roomDoc?.roomNo || roomId
    const cleanRoomNo = String(roomNo).trim()

    const activeOOO = await outOfOrderCollection.findOne({
        status: "active",
        roomNo: cleanRoomNo,
        startDate: { $lt: checkOut },
        endDate: { $gt: checkIn }
    })

    if (activeOOO) {
        return res.send({
            available: false,
            message: `Room ${cleanRoomNo} is Out of Order for maintenance (${activeOOO.reason || "Maintenance"}) from ${activeOOO.startDate} to ${activeOOO.endDate}. Bookings cannot be made for this room.`
        })
    }

    // 2. Check active booking conflicts
    const existingBooking = await findRoomConflict(bookingCollection, { roomId, checkIn, checkOut })
    if (existingBooking) {
        const conflictingRoom = getBookingRooms(existingBooking).find(room =>
            String(room.roomId) === String(roomId) &&
            room.checkIn < checkOut &&
            room.checkOut > checkIn
        )
        return res.send({
            available: false,
            message: `Room is already reserved from ${conflictingRoom?.checkIn || existingBooking.checkIn} to ${conflictingRoom?.checkOut || existingBooking.checkOut}. Please select different dates or another room.`,
            conflict: existingBooking
        })
    }
    res.send({ available: true, message: "Room is available for selected dates." })
})
// Get all active reserved date ranges for rooms (for calendar / availability preview)
app.get("/bookings/reserved-dates", async (req, res) => {
    const { roomId } = req.query
    const query = {
        status: { $in: ACTIVE_BOOKING_STATUSES }
    }
    if (roomId) {
        query.$or = [
            { roomId },
            { "rooms.roomId": roomId }
        ]
    }
    const bookings = await bookingCollection.find(query).toArray()
    const result = bookings.flatMap(booking =>
        getBookingRooms(booking)
            .filter(room => !roomId || String(room.roomId) === String(roomId))
            .map(room => ({
                bookingId: booking.bookingId,
                roomId: room.roomId,
                checkIn: room.checkIn,
                checkOut: room.checkOut,
                status: booking.status
            }))
    )
    res.send(result)
})

const handleCreateBooking = async (req, res) => {
    try {
        const data = req.body
        const rooms = normalizeBookingRooms(data)
        const validationError = validateBookingRooms(rooms)

        if (validationError) {
            return res.status(400).send({ message: validationError })
        }

        if (!data.name || !String(data.name).trim()) {
            return res.status(400).send({ message: "Guest name is required." })
        }
        if (!data.mobile || !String(data.mobile).trim()) {
            return res.status(400).send({ message: "Guest mobile number is required." })
        }

        for (const room of rooms) {
            const targetCategoryId = room.categoryId || room.roomId
            const catObjectId = toObjectId(targetCategoryId)
            const category = catObjectId ? await categoryAndRoomCollection.findOne({ _id: catObjectId }) : null

            if (category && Array.isArray(category.roomNumbers) && category.roomNumbers.length > 0) {
                const totalCategoryRooms = category.roomNumbers.length
                const cleanRoomNumbers = category.roomNumbers.map(r => String(r).trim()).filter(Boolean)

                // Count active Out-of-Order maintenance rooms in this category for overlapping dates
                const oooRooms = await outOfOrderCollection.find({
                    status: "active",
                    roomNo: { $in: cleanRoomNumbers },
                    startDate: { $lt: room.checkOut },
                    endDate: { $gt: room.checkIn }
                }).toArray()
                const oooCount = oooRooms.length
                const effectiveTotalRooms = Math.max(0, totalCategoryRooms - oooCount)

                // Count how many rooms in this request are for this category and overlapping dates
                const requestedCount = rooms.filter(r =>
                    (r.categoryId === targetCategoryId || r.roomId === targetCategoryId) &&
                    r.checkIn < room.checkOut &&
                    r.checkOut > room.checkIn
                ).length

                // Count how many active bookings exist for this category and overlapping dates
                const activeBookings = await bookingCollection.find({
                    status: { $in: ACTIVE_BOOKING_STATUSES },
                    $or: [
                        { "rooms.categoryId": targetCategoryId, "rooms.checkIn": { $lt: room.checkOut }, "rooms.checkOut": { $gt: room.checkIn } },
                        { "rooms.roomId": targetCategoryId, "rooms.checkIn": { $lt: room.checkOut }, "rooms.checkOut": { $gt: room.checkIn } },
                        { categoryId: targetCategoryId, checkIn: { $lt: room.checkOut }, checkOut: { $gt: room.checkIn } },
                        { roomId: targetCategoryId, checkIn: { $lt: room.checkOut }, checkOut: { $gt: room.checkIn } }
                    ]
                }).toArray()

                let alreadyBookedCount = 0
                activeBookings.forEach(b => {
                    const matchingRooms = getBookingRooms(b).filter(r =>
                        (String(r.categoryId) === String(targetCategoryId) || String(r.roomId) === String(targetCategoryId)) &&
                        r.checkIn < room.checkOut &&
                        r.checkOut > room.checkIn
                    )
                    alreadyBookedCount += matchingRooms.length
                })

                if ((alreadyBookedCount + requestedCount) > effectiveTotalRooms) {
                    const remaining = Math.max(0, effectiveTotalRooms - alreadyBookedCount)
                    const oooNotice = oooCount > 0 ? ` (${oooCount} room${oooCount > 1 ? 's' : ''} currently out of order for maintenance)` : ""
                    return res.status(409).send({
                        message: `Category "${category.name}" only has ${remaining} room(s) available${oooNotice} from ${room.checkIn} to ${room.checkOut}.`
                    })
                }
            }

            // Physical room conflict check & Out-of-Order check if roomNo is provided
            if (room.roomNo) {
                const cleanRoomNo = String(room.roomNo).trim()

                // Check if room is Out of Order
                const activeOOO = await outOfOrderCollection.findOne({
                    status: "active",
                    roomNo: cleanRoomNo,
                    startDate: { $lt: room.checkOut },
                    endDate: { $gt: room.checkIn }
                })

                if (activeOOO) {
                    return res.status(409).send({
                        message: `Room ${cleanRoomNo} is Out of Order for maintenance (${activeOOO.reason || "Maintenance"}) from ${activeOOO.startDate} to ${activeOOO.endDate}. Bookings cannot be made for this room.`
                    })
                }

                const existingBooking = await bookingCollection.findOne({
                    status: { $in: ACTIVE_BOOKING_STATUSES },
                    $or: [
                        {
                            rooms: {
                                $elemMatch: {
                                    roomNo: cleanRoomNo,
                                    checkIn: { $lt: room.checkOut },
                                    checkOut: { $gt: room.checkIn }
                                }
                            }
                        },
                        {
                            roomNo: cleanRoomNo,
                            checkIn: { $lt: room.checkOut },
                            checkOut: { $gt: room.checkIn }
                        }
                    ]
                })

                if (existingBooking) {
                    return res.status(409).send({
                        message: `Room ${cleanRoomNo} is already reserved for overlapping dates (${room.checkIn} to ${room.checkOut}). Please select another room or dates.`
                    })
                }
            }
        }

        const today = new Date()
        const requestedByRole = data.requestedByRole || data.role || "user"
        const status = data.status || BOOKING_STATUS.REQUEST_BOOKING

        // Physical room number is strictly required for any status beyond REQUEST_BOOKING
        if (status !== BOOKING_STATUS.REQUEST_BOOKING && status !== BOOKING_STATUS.CANCEL) {
            const missingRoom = rooms.find(r => !r.roomNo || !String(r.roomNo).trim())
            if (missingRoom) {
                return res.status(400).send({
                    message: `Physical room number is required for status "${status}". Please select room number(s).`
                })
            }
        }

        // Strict validation when creating a confirmed reservation directly
        const isConfirmedStatus = [
            BOOKING_STATUS.BOOKING_CONFIRMED,
            "booking_confirmed",
            BOOKING_STATUS.CHECKED_IN,
            "checked_id",
            "checked_in",
            BOOKING_STATUS.CHECKED_OUT,
            "checked_out",
            "confirmed"
        ].includes(status)

        if (isConfirmedStatus) {
            if (!data.name || !String(data.name).trim()) {
                return res.status(400).send({ message: "Guest Full Name is required for confirmed bookings." })
            }
            if (!data.mobile || !String(data.mobile).trim()) {
                return res.status(400).send({ message: "Guest Mobile number is required for confirmed bookings." })
            }

            const missingAdult = rooms.find(r => !r.adults || Number(r.adults) <= 0)
            if (missingAdult) {
                return res.status(400).send({ message: "Adult guest count is required for all rooms for confirmed bookings." })
            }

            const effectivePaid = Number(data.paidAmount !== undefined ? data.paidAmount : (data.advanceAmount || 0))
            if (isNaN(effectivePaid) || effectivePaid < 0) {
                return res.status(400).send({ message: "Payment Done amount cannot be negative." })
            }

            if (effectivePaid > 0) {
                if (!data.paymentMethod || !String(data.paymentMethod).trim()) {
                    return res.status(400).send({ message: "Payment Method is required for confirmed bookings with payment." })
                }

                const isDigitalMethod = isDigitalPaymentMethod(data.paymentMethod)
                if (isDigitalMethod && (!data.transactionId || !String(data.transactionId).trim())) {
                    return res.status(400).send({ message: `Transaction ID / Receipt No is required for ${data.paymentMethod}.` })
                }
            }

            if (!data.reference || !String(data.reference).trim()) {
                return res.status(400).send({ message: "Staff / Admin Reference is required for confirmed bookings." })
            }
        }

        const postPaid = Number(data.paidAmount || 0)
        const postTotal = Number(data.totalAmount || 0)
        if (!isNaN(postPaid) && !isNaN(postTotal) && postTotal > 0 && postPaid > postTotal + 0.01) {
            return res.status(400).send({ message: `Paid amount (${postPaid}) cannot exceed the booking total (${postTotal}).` })
        }

        const expireHours = getRequestBookingExpireHours(requestedByRole)
        const requestExpiresAt = status === BOOKING_STATUS.REQUEST_BOOKING ? new Date(today.getTime() + expireHours * 60 * 60 * 1000) : undefined

        const resolvedReference = (data.reference && String(data.reference).trim())
            ? String(data.reference).trim()
            : (requestedByRole === "user" ? "Website Direct" : (data.changedBy?.name || "Front Desk"))

        const actorInfo = data.changedBy || data.bookedBy || {
            name: data.name || "Guest",
            email: data.userEmail || data.email || "",
            role: requestedByRole
        }

        let normalizedExtraServices = null
        let resolvedExtraServiceName = ""
        let resolvedExtraServiceCost = 0

        if (Array.isArray(data.extraServices)) {
            normalizedExtraServices = data.extraServices.map(s => ({
                serviceId: s.serviceId || s._id || "",
                name: s.name || "",
                billingType: s.billingType || "One-time",
                unitPrice: Number(s.unitPrice !== undefined ? s.unitPrice : (s.price || 0)),
                quantity: Math.max(1, Number(s.quantity || 1)),
                totalCost: Number(s.totalCost !== undefined ? s.totalCost : (Number(s.unitPrice || s.price || 0) * Math.max(1, Number(s.quantity || 1))))
            }))
            resolvedExtraServiceName = normalizedExtraServices.map(s => s.name).filter(Boolean).join(", ")
            resolvedExtraServiceCost = normalizedExtraServices.reduce((sum, s) => sum + Number(s.totalCost || 0), 0)
        } else if (data.extraServices && typeof data.extraServices === 'object') {
            normalizedExtraServices = [data.extraServices]
            resolvedExtraServiceName = data.extraServices.name || data.extraService || ""
            resolvedExtraServiceCost = Number(data.extraServices.totalCost !== undefined ? data.extraServices.totalCost : (data.extraServiceCost || 0))
        } else if (data.extraService) {
            resolvedExtraServiceName = data.extraService
            resolvedExtraServiceCost = Number(data.extraServiceCost || 0)
            normalizedExtraServices = [{
                name: data.extraService,
                totalCost: resolvedExtraServiceCost,
                quantity: Number(data.extraServiceQuantity || 1),
                billingType: data.extraServiceBillingType || "Per Night",
                unitPrice: Number(data.extraServiceUnitPrice || resolvedExtraServiceCost)
            }]
        }

        const roomTotal = rooms.reduce((sum, r) => sum + getRoomTotal(r), 0)
        const computedBookingTotal = Math.max(0, roomTotal + resolvedExtraServiceCost - Number(data.discountAmount || 0))
        const finalTotalAmount = data.totalAmount !== undefined && data.totalAmount !== null && !isNaN(Number(data.totalAmount))
            ? Number(data.totalAmount)
            : computedBookingTotal
        const finalPaidAmount = data.paidAmount !== undefined ? Number(data.paidAmount) : 0
        const finalDueAmount = data.dueAmount !== undefined ? Number(data.dueAmount) : Math.max(0, finalTotalAmount - finalPaidAmount)

        const bookingData = {
            name: data.name,
            mobile: data.mobile,
            address: data.address || "",
            userEmail: data.userEmail || data.email || "",
            rooms,
            totalAmount: finalTotalAmount,
            discountAmount: Number(data.discountAmount || 0),
            paidAmount: finalPaidAmount,
            dueAmount: finalDueAmount,
            paymentMethod: data.paymentMethod || "Cash",
            paymentHistory: data.paidAmount && Number(data.paidAmount) > 0 ? [{
                amount: Number(data.paidAmount),
                paymentMethod: data.paymentMethod || "Cash",
                reference: resolvedReference,
                transactionId: data.transactionId || "",
                note: "Initial payment during reservation",
                date: today,
                collectedBy: actorInfo
            }] : [],
            extraService: resolvedExtraServiceName,
            extraServiceCost: resolvedExtraServiceCost,
            extraServices: normalizedExtraServices,
            reference: resolvedReference,
            bookedBy: data.bookedBy || actorInfo,
            createdBy: data.createdBy || actorInfo,
            transactionId: data.transactionId || "",
            notes: data.notes || "",
            guestType: data.guestType || ((requestedByRole === "user" || !requestedByRole || String(resolvedReference || "").toLowerCase().includes("website")) ? "WEB" : "Walk-In"),
            createdAt: today,
            requestedByRole,
            status,
            statusHistory: [{
                status,
                time: today,
                changedBy: actorInfo
            }]
        }
        if (requestExpiresAt) {
            bookingData.requestExpiresAt = requestExpiresAt
        }

        for (let attempt = 1; attempt <= 5; attempt++) {
            const bookingId = generateBookingId()

            try {
                const result = await bookingCollection.insertOne({ ...bookingData, bookingId })
                result.bookingId = bookingId
                return res.send(result)
            } catch (error) {
                if (error.code !== 11000 || attempt === 5) {
                    throw error
                }
            }
        }
    } catch (err) {
        console.error("Create booking error:", err)
        return res.status(500).send({ message: err.message || "Failed to create reservation." })
    }
}

app.post("/bookings", handleCreateBooking)
app.post("/booking", handleCreateBooking)

// Public Guest Lookup endpoint (fetches bookings matching stored localStorage IDs)
app.post("/bookings/by-ids", async (req, res) => {
    try {
        const { bookingIds } = req.body
        if (!Array.isArray(bookingIds) || bookingIds.length === 0) {
            return res.send([])
        }
        const cleanIds = bookingIds.map(id => String(id).trim()).filter(Boolean)
        if (cleanIds.length === 0) {
            return res.send([])
        }
        const docs = await bookingCollection.find({ bookingId: { $in: cleanIds } }).sort({ _id: -1 }).toArray()
        const hydrated = await hydrateBookingsWithRooms(docs, roomCollection, categoryAndRoomCollection)
        res.send(hydrated)
    } catch (err) {
        console.error("Fetch bookings by IDs error:", err)
        res.status(500).send({ message: "Failed to fetch reservations." })
    }
})

// Protected Claim Guest Bookings endpoint (links guest bookings to newly logged-in account)
app.post("/bookings/claim-guest-bookings", verifyFBToken, async (req, res) => {
    try {
        const { bookingIds, userEmail, name } = req.body
        const targetEmail = req.decodedEmail || userEmail
        if (!Array.isArray(bookingIds) || bookingIds.length === 0 || !targetEmail) {
            return res.status(400).send({ message: "Valid booking IDs and user email are required." })
        }
        const cleanIds = bookingIds.map(id => String(id).trim()).filter(Boolean)
        if (cleanIds.length === 0) {
            return res.send({ modifiedCount: 0 })
        }

        const now = new Date()
        const result = await bookingCollection.updateMany(
            {
                bookingId: { $in: cleanIds },
                $or: [
                    { userEmail: { $exists: false } },
                    { userEmail: "" },
                    { userEmail: null },
                    { userEmail: { $regex: `^${targetEmail}$`, $options: "i" } }
                ]
            },
            {
                $set: {
                    userEmail: targetEmail,
                    "bookedBy.email": targetEmail,
                    "bookedBy.name": name || "Guest",
                    "bookedBy.role": "user",
                    updatedAt: now
                }
            }
        )
        res.send(result)
    } catch (err) {
        console.error("Claim guest bookings error:", err)
        res.status(500).send({ message: "Failed to claim reservations." })
    }
})

app.get("/bookings", verifyFBToken, async (req, res) => {
    try {
        const { email, status, reference, search, skip, limit, startDate, endDate } = req.query
        const isPaginated = skip !== undefined || limit !== undefined
        const parsedLimit = limit !== undefined ? Math.max(1, parseInt(limit, 10) || 25) : 0
        const parsedSkip = skip !== undefined ? Math.max(0, parseInt(skip, 10) || 0) : 0

        const andConditions = []

        const cleanStartDate = typeof startDate === 'string' ? startDate.trim() : null
        const cleanEndDate = typeof endDate === 'string' ? endDate.trim() : null

        if (cleanStartDate || cleanEndDate) {
            let endThreshold = cleanEndDate
            if (cleanEndDate && /^\d{4}-\d{2}-\d{2}$/.test(cleanEndDate)) {
                const nextDay = new Date(`${cleanEndDate}T00:00:00`)
                nextDay.setDate(nextDay.getDate() + 1)
                const y = nextDay.getFullYear()
                const m = String(nextDay.getMonth() + 1).padStart(2, '0')
                const d = String(nextDay.getDate()).padStart(2, '0')
                endThreshold = `${y}-${m}-${d}`
            }

            const roomElemMatch = {}
            const rootMatch = {}

            if (endThreshold) {
                roomElemMatch.checkIn = { $gte: "1900", $lt: endThreshold }
                rootMatch.checkIn = { $gte: "1900", $lt: endThreshold }
            }
            if (cleanStartDate) {
                roomElemMatch.checkOut = { $gt: cleanStartDate }
                rootMatch.checkOut = { $gt: cleanStartDate }
            }

            andConditions.push({
                $or: [
                    { rooms: { $elemMatch: roomElemMatch } },
                    rootMatch
                ]
            })
        }

        if (email) {
            const escEmail = String(email).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            const emailRegex = { $regex: `^${escEmail}$`, $options: "i" }
            andConditions.push({
                $or: [
                    { userEmail: emailRegex },
                    { "bookedBy.email": emailRegex },
                    { "createdBy.email": emailRegex }
                ]
            })
        }

        if (reference) {
            const escRef = String(reference).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            const refRegex = { $regex: escRef, $options: "i" }
            andConditions.push({
                $or: [
                    { reference: refRegex },
                    { "bookedBy.name": refRegex },
                    { "bookedBy.email": refRegex },
                    { "createdBy.name": refRegex }
                ]
            })
        }

        if (status) {
            if (Array.isArray(status)) {
                andConditions.push({ status: { $in: status } })
            } else if (status === "cancel" || status === "cancelled") {
                andConditions.push({ status: { $in: CANCEL_STATUSES } })
            } else if (status === "checked_id" || status === "checked_in") {
                andConditions.push({ status: { $in: ["checked_id", "checked_in"] } })
            } else if (status === "booking_confirmed" || status === "confirmed") {
                andConditions.push({ status: { $in: ["booking_confirmed", "confirmed"] } })
            } else {
                andConditions.push({ status })
            }
        }

        if (search && String(search).trim()) {
            const escSearch = String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            const sRegex = { $regex: escSearch, $options: "i" }
            andConditions.push({
                $or: [
                    { name: sRegex },
                    { mobile: sRegex },
                    { bookingId: sRegex },
                    { reference: sRegex },
                    { address: sRegex },
                    { userEmail: sRegex },
                    { "bookedBy.name": sRegex },
                    { "bookedBy.email": sRegex },
                    { "rooms.categoryName": sRegex },
                    { "rooms.roomNo": sRegex },
                    { roomName: sRegex },
                    { roomCategory: sRegex }
                ]
            })
        }

        const query = andConditions.length > 0 ? { $and: andConditions } : {}
        const sort = { _id: -1 }

        const bookingListProjection = {
            _id: 1,
            bookingId: 1,
            name: 1,
            mobile: 1,
            address: 1,
            userEmail: 1,
            rooms: 1,
            totalAmount: 1,
            discountAmount: 1,
            paidAmount: 1,
            dueAmount: 1,
            paymentMethod: 1,
            extraService: 1,
            extraServiceCost: 1,
            extraServices: 1,
            reference: 1,
            bookedBy: 1,
            createdBy: 1,
            changedBy: 1,
            transactionId: 1,
            notes: 1,
            guestType: 1,
            checkIn: 1,
            checkOut: 1,
            roomName: 1,
            roomCategory: 1,
            createdAt: 1,
            requestedByRole: 1,
            status: 1,
            cancelledAt: 1,
            cancelledBy: 1,
            cancelReason: 1,
            refundAmount: 1,
            advanceAmount: 1,
            updatedAt: 1
        }

        if (isPaginated) {
            const pipeline = [
                { $match: query },
                { $sort: sort },
                {
                    $facet: {
                        paginatedResults: [
                            { $skip: parsedSkip },
                            { $limit: parsedLimit || 25 },
                            { $project: bookingListProjection }
                        ],
                        totalCount: [
                            { $count: "count" }
                        ]
                    }
                }
            ]
            const [facetResult] = await bookingCollection.aggregate(pipeline).toArray()
            const rawBookings = facetResult?.paginatedResults || []
            const totalDataCount = facetResult?.totalCount?.[0]?.count || 0
            const result = await hydrateBookingsWithRooms(rawBookings, roomCollection, categoryAndRoomCollection)
            return res.send({ result, totalDataCount })
        }

        const bookings = await bookingCollection
            .find(query)
            .sort(sort)
            .project(bookingListProjection)
            .toArray()
        const result = await hydrateBookingsWithRooms(bookings, roomCollection, categoryAndRoomCollection)
        res.send(result)
    } catch (err) {
        console.error("GET /bookings error:", err)
        res.status(500).send({ message: "Failed to fetch reservations." })
    }
})

app.get("/bookings/references", verifyFBToken, async (req, res) => {
    try {
        const refs = await bookingCollection.distinct("reference")
        const staffNames = await bookingCollection.distinct("bookedBy.name")
        const combined = Array.from(new Set([...refs, ...staffNames].filter(r => r && typeof r === 'string' && r.trim())))
        combined.sort((a, b) => a.localeCompare(b))
        res.send(combined)
    } catch (err) {
        console.error("GET /bookings/references error:", err)
        res.status(500).send({ message: "Failed to fetch references." })
    }
})

app.get("/booking/:id", verifyFBToken, async (req, res) => {
    const { id } = req.params
    const objectId = toObjectId(id)
    const query = objectId ? { _id: objectId } : { bookingId: id }
    const booking = await bookingCollection.findOne(query)
    const [result] = await hydrateBookingsWithRooms(booking ? [booking] : [], roomCollection, categoryAndRoomCollection)
    res.send(result || null)
})

function formatAuditDate(dateStr) {
    if (!dateStr) return ""
    try {
        const parts = String(dateStr).trim().split('-')
        if (parts.length === 3) {
            const [y, m, d] = parts
            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
            const monthIdx = parseInt(m, 10) - 1
            const monthName = months[monthIdx] || m
            const cleanDay = String(d).padStart(2, '0')
            return `${cleanDay} ${monthName} ${y}`
        }
        const d = new Date(dateStr)
        if (!isNaN(d.getTime())) {
            const day = String(d.getDate()).padStart(2, '0')
            const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
            return `${day} ${months[d.getMonth()]} ${d.getFullYear()}`
        }
        return String(dateStr)
    } catch {
        return String(dateStr)
    }
}

function detectBookingChanges(oldDoc, updatePayload) {
    if (!oldDoc || !updatePayload) return []
    const changes = []

    const normalizeStr = (val) => (val !== undefined && val !== null ? String(val).trim() : "")
    const normalizeNum = (val) => (val !== undefined && val !== null && !isNaN(Number(val)) ? Number(val) : null)

    // 1. Stay Dates
    const oldRooms = Array.isArray(oldDoc.rooms) && oldDoc.rooms.length > 0 ? oldDoc.rooms : []
    const newRooms = Array.isArray(updatePayload.rooms) ? updatePayload.rooms : null

    const oldCheckIn = normalizeStr(oldRooms[0]?.checkIn || oldDoc.checkIn)
    const oldCheckOut = normalizeStr(oldRooms[0]?.checkOut || oldDoc.checkOut)
    const newCheckIn = normalizeStr(newRooms?.[0]?.checkIn || updatePayload.checkIn)
    const newCheckOut = normalizeStr(newRooms?.[0]?.checkOut || updatePayload.checkOut)

    if (newCheckIn && oldCheckIn && (oldCheckIn !== newCheckIn || oldCheckOut !== newCheckOut)) {
        const oldFormatted = `${formatAuditDate(oldCheckIn)} to ${formatAuditDate(oldCheckOut)}`
        const newFormatted = `${formatAuditDate(newCheckIn)} to ${formatAuditDate(newCheckOut)}`
        changes.push({
            field: "stayDates",
            label: "Stay Dates",
            oldValue: oldFormatted,
            newValue: newFormatted,
            description: `Stay dates changed from ${formatAuditDate(oldCheckIn)} - ${formatAuditDate(oldCheckOut)} to ${formatAuditDate(newCheckIn)} - ${formatAuditDate(newCheckOut)}`
        })
    }

    // 2. Room Assignments & Configurations
    if (newRooms) {
        if (oldRooms.length > 0 && oldRooms.length !== newRooms.length) {
            changes.push({
                field: "roomCount",
                label: "Room Count",
                oldValue: `${oldRooms.length} room(s)`,
                newValue: `${newRooms.length} room(s)`,
                description: `Room count modified from ${oldRooms.length} to ${newRooms.length}`
            })
        }

        const maxRooms = Math.max(oldRooms.length, newRooms.length)
        for (let i = 0; i < maxRooms; i++) {
            const oldR = oldRooms[i] || {}
            const newR = newRooms[i] || {}

            const oldRoomNo = normalizeStr(oldR.roomNo) || "Unassigned"
            const newRoomNo = normalizeStr(newR.roomNo) || "Unassigned"

            if (newR.roomNo !== undefined && oldRoomNo !== newRoomNo) {
                changes.push({
                    field: `roomNo_${i + 1}`,
                    label: `Room ${i + 1} Assignment`,
                    oldValue: oldRoomNo,
                    newValue: newRoomNo,
                    description: `Room ${i + 1} assignment changed from ${oldRoomNo} to ${newRoomNo}`
                })
            }

            const oldCategory = normalizeStr(oldR.categoryName || oldDoc.categoryName)
            const newCategory = normalizeStr(newR.categoryName)
            if (newCategory && oldCategory && oldCategory !== newCategory) {
                changes.push({
                    field: `category_${i + 1}`,
                    label: `Room ${i + 1} Category`,
                    oldValue: oldCategory,
                    newValue: newCategory,
                    description: `Room ${i + 1} category changed from "${oldCategory}" to "${newCategory}"`
                })
            }

            const oldAdults = normalizeNum(oldR.adults)
            const newAdults = normalizeNum(newR.adults)
            if (newAdults !== null && oldAdults !== null && oldAdults !== newAdults) {
                changes.push({
                    field: `adults_${i + 1}`,
                    label: `Room ${i + 1} Adults`,
                    oldValue: `${oldAdults} Adults`,
                    newValue: `${newAdults} Adults`,
                    description: `Room ${i + 1} adults updated from ${oldAdults} to ${newAdults}`
                })
            }

            const oldChildren = normalizeNum(oldR.children !== undefined ? oldR.children : oldR.babies)
            const newChildren = normalizeNum(newR.children !== undefined ? newR.children : newR.babies)
            if (newChildren !== null && oldChildren !== null && oldChildren !== newChildren) {
                changes.push({
                    field: `children_${i + 1}`,
                    label: `Room ${i + 1} Children`,
                    oldValue: `${oldChildren} Children`,
                    newValue: `${newChildren} Children`,
                    description: `Room ${i + 1} children updated from ${oldChildren} to ${newChildren}`
                })
            }
        }
    }

    // 3. Pricing & Financials
    const oldTotal = normalizeNum(oldDoc.totalAmount) || 0
    const newTotal = normalizeNum(updatePayload.totalAmount)
    if (newTotal !== null && Math.abs(oldTotal - newTotal) > 0.01) {
        changes.push({
            field: "totalAmount",
            label: "Total Amount",
            oldValue: `৳${oldTotal.toLocaleString()}`,
            newValue: `৳${newTotal.toLocaleString()}`,
            description: `Total amount changed from ৳${oldTotal.toLocaleString()} to ৳${newTotal.toLocaleString()}`
        })
    }

    const oldDiscount = normalizeNum(oldDoc.discountAmount) || 0
    const newDiscount = normalizeNum(updatePayload.discountAmount)
    if (newDiscount !== null && Math.abs(oldDiscount - newDiscount) > 0.01) {
        changes.push({
            field: "discountAmount",
            label: "Discount",
            oldValue: `৳${oldDiscount.toLocaleString()}`,
            newValue: `৳${newDiscount.toLocaleString()}`,
            description: `Discount changed from ৳${oldDiscount.toLocaleString()} to ৳${newDiscount.toLocaleString()}`
        })
    }

    const oldPaid = normalizeNum(oldDoc.paidAmount !== undefined ? oldDoc.paidAmount : oldDoc.advanceAmount) || 0
    const newPaid = normalizeNum(updatePayload.paidAmount)
    if (newPaid !== null && Math.abs(oldPaid - newPaid) > 0.01) {
        changes.push({
            field: "paidAmount",
            label: "Paid Amount",
            oldValue: `৳${oldPaid.toLocaleString()}`,
            newValue: `৳${newPaid.toLocaleString()}`,
            description: `Paid amount changed from ৳${oldPaid.toLocaleString()} to ৳${newPaid.toLocaleString()}`
        })
    }

    const oldExtraCost = normalizeNum(oldDoc.extraServiceCost) || 0
    const newExtraCost = normalizeNum(updatePayload.extraServiceCost)
    if (newExtraCost !== null && Math.abs(oldExtraCost - newExtraCost) > 0.01) {
        changes.push({
            field: "extraServiceCost",
            label: "Extra Service Cost",
            oldValue: `৳${oldExtraCost.toLocaleString()}`,
            newValue: `৳${newExtraCost.toLocaleString()}`,
            description: `Extra service cost changed from ৳${oldExtraCost.toLocaleString()} to ৳${newExtraCost.toLocaleString()}`
        })
    }

    const oldExtraService = normalizeStr(oldDoc.extraService)
    const newExtraService = updatePayload.extraService !== undefined ? normalizeStr(updatePayload.extraService) : null
    if (newExtraService !== null && oldExtraService !== newExtraService) {
        changes.push({
            field: "extraService",
            label: "Extra Services",
            oldValue: oldExtraService || "None",
            newValue: newExtraService || "None",
            description: `Extra services updated to "${newExtraService || "None"}"`
        })
    }

    // 4. Guest Details
    const oldName = normalizeStr(oldDoc.name)
    const newName = updatePayload.name !== undefined ? normalizeStr(updatePayload.name) : null
    if (newName !== null && oldName !== newName) {
        changes.push({
            field: "name",
            label: "Guest Name",
            oldValue: oldName || "None",
            newValue: newName || "None",
            description: `Guest name updated from "${oldName}" to "${newName}"`
        })
    }

    const oldMobile = normalizeStr(oldDoc.mobile)
    const newMobile = updatePayload.mobile !== undefined ? normalizeStr(updatePayload.mobile) : null
    if (newMobile !== null && oldMobile !== newMobile) {
        changes.push({
            field: "mobile",
            label: "Guest Mobile",
            oldValue: oldMobile || "None",
            newValue: newMobile || "None",
            description: `Guest mobile changed from "${oldMobile}" to "${newMobile}"`
        })
    }

    const oldAddress = normalizeStr(oldDoc.address)
    const newAddress = updatePayload.address !== undefined ? normalizeStr(updatePayload.address) : null
    if (newAddress !== null && oldAddress !== newAddress) {
        changes.push({
            field: "address",
            label: "Guest Address",
            oldValue: oldAddress || "None",
            newValue: newAddress || "None",
            description: `Guest address updated`
        })
    }

    const oldEmail = normalizeStr(oldDoc.userEmail || oldDoc.email)
    const newEmail = updatePayload.userEmail !== undefined ? normalizeStr(updatePayload.userEmail) : null
    if (newEmail !== null && oldEmail !== newEmail) {
        changes.push({
            field: "userEmail",
            label: "Guest Email",
            oldValue: oldEmail || "None",
            newValue: newEmail || "None",
            description: `Guest email updated from "${oldEmail}" to "${newEmail}"`
        })
    }

    // 5. Reference & Notes
    const oldRef = normalizeStr(oldDoc.reference)
    const newRef = updatePayload.reference !== undefined ? normalizeStr(updatePayload.reference) : null
    if (newRef !== null && oldRef !== newRef) {
        changes.push({
            field: "reference",
            label: "Staff Reference",
            oldValue: oldRef || "None",
            newValue: newRef || "None",
            description: `Staff reference changed to "${newRef || "None"}"`
        })
    }

    const oldNotes = normalizeStr(oldDoc.notes)
    const newNotes = updatePayload.notes !== undefined ? normalizeStr(updatePayload.notes) : null
    if (newNotes !== null && oldNotes !== newNotes) {
        changes.push({
            field: "notes",
            label: "Special Notes",
            oldValue: oldNotes || "None",
            newValue: newNotes || "None",
            description: `Special notes updated`
        })
    }

    // 6. Status
    const oldStatus = normalizeStr(oldDoc.status)
    const newStatus = normalizeStr(updatePayload.status)
    if (newStatus && oldStatus && oldStatus !== newStatus) {
        changes.push({
            field: "status",
            label: "Status Transition",
            oldValue: oldStatus,
            newValue: newStatus,
            description: `Status changed from "${oldStatus}" to "${newStatus}"`
        })
    }

    return changes
}

app.patch("/booking/:id", verifyFBToken, async (req, res) => {
    const { id } = req.params
    const query = toObjectId(id) ? { _id: toObjectId(id) } : { _id: id }
    const now = new Date()
    const {
        status,
        requestedByRole,
        name,
        mobile,
        address,
        userEmail,
        rooms,
        totalAmount,
        paidAmount,
        discountAmount,
        advanceAmount,
        reference,
        transactionId,
        notes,
        cancelReason,
        changedBy
    } = req.body

    const currentDoc = await bookingCollection.findOne(query)
    if (!currentDoc) {
        return res.status(404).send({ message: "Reservation not found." })
    }

    // Resolve actor info for audit trail
    const actorInfo = changedBy || {
        email: req.decodedEmail || "",
        name: req.body.changedByName || "Staff / Admin",
        role: requestedByRole || "admin"
    }

    const updateData = { updatedAt: now }
    if (name !== undefined) updateData.name = name
    if (mobile !== undefined) updateData.mobile = mobile
    if (address !== undefined) updateData.address = address
    if (Array.isArray(rooms)) {
        updateData.rooms = rooms.map(r => ({
            ...r,
            nights: Number(r.nights) || getNightCount(r.checkIn || currentDoc.checkIn, r.checkOut || currentDoc.checkOut) || 1
        }))
    }
    if (paidAmount !== undefined) updateData.paidAmount = Number(paidAmount)
    if (discountAmount !== undefined) updateData.discountAmount = Number(discountAmount)
    if (advanceAmount !== undefined) updateData.advanceAmount = Number(advanceAmount)
    if (reference !== undefined) updateData.reference = reference
    if (transactionId !== undefined) updateData.transactionId = transactionId
    if (notes !== undefined) updateData.notes = notes
    if (req.body.extraServices !== undefined) {
        if (Array.isArray(req.body.extraServices)) {
            const normalized = req.body.extraServices.map(s => ({
                serviceId: s.serviceId || s._id || "",
                name: s.name || "",
                billingType: s.billingType || "One-time",
                unitPrice: Number(s.unitPrice !== undefined ? s.unitPrice : (s.price || 0)),
                quantity: Math.max(1, Number(s.quantity || 1)),
                totalCost: Number(s.totalCost !== undefined ? s.totalCost : (Number(s.unitPrice || s.price || 0) * Math.max(1, Number(s.quantity || 1))))
            }))
            updateData.extraServices = normalized
            updateData.extraService = normalized.map(s => s.name).filter(Boolean).join(", ")
            updateData.extraServiceCost = normalized.reduce((sum, s) => sum + Number(s.totalCost || 0), 0)
        } else if (req.body.extraServices && typeof req.body.extraServices === 'object') {
            updateData.extraServices = [req.body.extraServices]
            updateData.extraService = req.body.extraServices.name || req.body.extraService || ""
            updateData.extraServiceCost = Number(req.body.extraServices.totalCost !== undefined ? req.body.extraServices.totalCost : (req.body.extraServiceCost || 0))
        } else {
            updateData.extraServices = []
            updateData.extraService = ""
            updateData.extraServiceCost = 0
        }
    } else {
        if (req.body.extraService !== undefined) updateData.extraService = req.body.extraService
        if (req.body.extraServiceCost !== undefined) updateData.extraServiceCost = Number(req.body.extraServiceCost || 0)
    }
    if (req.body.paymentMethod !== undefined) updateData.paymentMethod = req.body.paymentMethod

    // Total amount and due amount persistence & auto-recalculation
    if (totalAmount !== undefined && totalAmount !== null && !isNaN(Number(totalAmount))) {
        updateData.totalAmount = Number(totalAmount)
    } else if (updateData.rooms !== undefined || updateData.extraServices !== undefined || updateData.extraServiceCost !== undefined || updateData.discountAmount !== undefined) {
        const effectiveRooms = updateData.rooms || currentDoc.rooms || []
        const effectiveExtraCost = updateData.extraServiceCost !== undefined ? updateData.extraServiceCost : Number(currentDoc.extraServiceCost || 0)
        const effectiveDiscount = updateData.discountAmount !== undefined ? updateData.discountAmount : Number(currentDoc.discountAmount || 0)
        const roomTotal = effectiveRooms.reduce((sum, r) => sum + getRoomTotal(r), 0)
        updateData.totalAmount = Math.max(0, roomTotal + effectiveExtraCost - effectiveDiscount)
    }

    if (req.body.dueAmount !== undefined && req.body.dueAmount !== null && !isNaN(Number(req.body.dueAmount))) {
        updateData.dueAmount = Number(req.body.dueAmount)
    } else if (updateData.totalAmount !== undefined || updateData.paidAmount !== undefined) {
        const effectiveTotal = updateData.totalAmount !== undefined ? updateData.totalAmount : Number(currentDoc.totalAmount || 0)
        const effectivePaid = updateData.paidAmount !== undefined ? updateData.paidAmount : Number(currentDoc.paidAmount || currentDoc.advanceAmount || 0)
        updateData.dueAmount = Math.max(0, effectiveTotal - effectivePaid)
    }

    const update = { $set: updateData }

    // Detect and record fine-grained field changes into editHistory
    const detectedChanges = detectBookingChanges(currentDoc, { ...req.body, ...updateData })
    if (detectedChanges.length > 0) {
        const editLogEntry = {
            timestamp: now,
            changedBy: actorInfo,
            summary: detectedChanges.map(c => c.description),
            changes: detectedChanges
        }
        if (!update.$push) update.$push = {}
        update.$push.editHistory = editLogEntry
    }

    // Validate rooms against Out of Order maintenance and conflicts
    const targetRoomsForValidation = Array.isArray(rooms) && rooms.length > 0
        ? rooms
        : (status && status !== BOOKING_STATUS.CANCEL ? (currentDoc.rooms || []) : [])

    if (targetRoomsForValidation.length > 0 && status !== BOOKING_STATUS.CANCEL) {
        for (const r of targetRoomsForValidation) {
            if (r.roomNo) {
                const cleanRoomNo = String(r.roomNo).trim()
                const checkIn = r.checkIn
                const checkOut = r.checkOut

                if (cleanRoomNo && checkIn && checkOut) {
                    // 1. Check Out of Order
                    const activeOOO = await outOfOrderCollection.findOne({
                        status: "active",
                        roomNo: cleanRoomNo,
                        startDate: { $lt: checkOut },
                        endDate: { $gt: checkIn }
                    })

                    if (activeOOO) {
                        return res.status(409).send({
                            message: `Room ${cleanRoomNo} is Out of Order for maintenance (${activeOOO.reason || "Maintenance"}) from ${activeOOO.startDate} to ${activeOOO.endDate}. It cannot be assigned or confirmed.`
                        })
                    }

                    // 2. Check room conflict with another active booking
                    const existingConflict = await bookingCollection.findOne({
                        _id: { $ne: query._id || (toObjectId(id) || id) },
                        status: { $in: ACTIVE_BOOKING_STATUSES },
                        $or: [
                            {
                                rooms: {
                                    $elemMatch: {
                                        roomNo: cleanRoomNo,
                                        checkIn: { $lt: checkOut },
                                        checkOut: { $gt: checkIn }
                                    }
                                }
                            },
                            {
                                roomNo: cleanRoomNo,
                                checkIn: { $lt: checkOut },
                                checkOut: { $gt: checkIn }
                            }
                        ]
                    })

                    if (existingConflict) {
                        return res.status(409).send({
                            message: `Room ${cleanRoomNo} is already occupied by booking ${existingConflict.bookingId} (${existingConflict.name}) for overlapping stay dates.`
                        })
                    }
                }
            }
        }
    }

    if (status) {
        // Physical room number is strictly required for any status beyond REQUEST_BOOKING
        if (status !== BOOKING_STATUS.REQUEST_BOOKING && status !== BOOKING_STATUS.CANCEL) {
            const targetRooms = Array.isArray(rooms) && rooms.length > 0
                ? rooms
                : (currentDoc.rooms || [])
            const missingRoom = targetRooms.find(r => !r.roomNo || !String(r.roomNo).trim())
            if (missingRoom) {
                return res.status(400).send({
                    message: `Physical room number is required for status "${status}". Please assign room number(s).`
                })
            }
        }

        // Strict validation when confirming booking or checking in
        const isConfirmedStatus = [
            BOOKING_STATUS.BOOKING_CONFIRMED,
            "booking_confirmed",
            BOOKING_STATUS.CHECKED_IN,
            "checked_id",
            "checked_in",
            BOOKING_STATUS.CHECKED_OUT,
            "checked_out",
            "confirmed"
        ].includes(status)

        if (isConfirmedStatus) {
            const targetRooms = Array.isArray(rooms) && rooms.length > 0 ? rooms : (currentDoc?.rooms || [])

            const effectiveName = updateData.name || currentDoc?.name
            const effectiveMobile = updateData.mobile || currentDoc?.mobile
            if (!effectiveName || !String(effectiveName).trim()) {
                return res.status(400).send({ message: "Guest Full Name is required for confirmed bookings." })
            }
            if (!effectiveMobile || !String(effectiveMobile).trim()) {
                return res.status(400).send({ message: "Guest Mobile / WhatsApp number is required for confirmed bookings." })
            }

            const missingAdult = targetRooms.find(r => !r.adults || Number(r.adults) <= 0)
            if (missingAdult) {
                return res.status(400).send({ message: "Adult guest count is required for all rooms for confirmed bookings." })
            }

            const effectivePaid = Number(updateData.paidAmount !== undefined ? updateData.paidAmount : (currentDoc?.paidAmount || 0))
            if (isNaN(effectivePaid) || effectivePaid < 0) {
                return res.status(400).send({ message: "Payment Done amount cannot be negative." })
            }

            if (effectivePaid > 0) {
                const effectiveMethod = updateData.paymentMethod || currentDoc?.paymentMethod
                if (!effectiveMethod || !String(effectiveMethod).trim()) {
                    return res.status(400).send({ message: "Payment Method is required for confirmed bookings with payment." })
                }

                const isDigitalMethod = isDigitalPaymentMethod(effectiveMethod)
                const effectiveTrx = updateData.transactionId !== undefined ? updateData.transactionId : (currentDoc?.transactionId || "")
                if (isDigitalMethod && (!effectiveTrx || !String(effectiveTrx).trim())) {
                    return res.status(400).send({ message: `Transaction ID / Receipt No is required for ${effectiveMethod}.` })
                }
            }

            const effectiveRef = updateData.reference !== undefined ? updateData.reference : (currentDoc?.reference || updateData.changedBy?.name || "")
            if (!effectiveRef || !String(effectiveRef).trim()) {
                return res.status(400).send({ message: "Staff / Admin Reference is required for confirmed bookings." })
            }
        }

        // Check-out requires full payment
        if (status === BOOKING_STATUS.CHECKED_OUT || status === "checked_out") {
            const effectiveTotal = getBookingTotal({ ...currentDoc, ...updateData })
            const effectivePaid = updateData.paidAmount !== undefined ? updateData.paidAmount : getBookingPaidAmount(currentDoc)
            const remainingDue = Math.max(0, effectiveTotal - effectivePaid)
            if (remainingDue > 0.01) {
                return res.status(400).send({
                    message: `Cannot check out: Outstanding balance of ৳${remainingDue.toLocaleString()} is remaining. Please complete full payment before checking out.`
                })
            }
        }

        // Universal guard: paid can never exceed total
        if (updateData.paidAmount !== undefined) {
            const patchPaid = Number(updateData.paidAmount)
            const patchTotal = updateData.totalAmount !== undefined ? Number(updateData.totalAmount) : Number(currentDoc.totalAmount || 0)
            if (!isNaN(patchPaid) && !isNaN(patchTotal) && patchTotal > 0 && patchPaid > patchTotal + 0.01) {
                return res.status(400).send({ message: `Paid amount (${patchPaid}) cannot exceed the booking total (${patchTotal}).` })
            }
        }

        updateData.status = status
        updateData.statusUpdatedAt = now

        const historyItem = {
            status,
            time: now,
            changedBy: actorInfo
        }
        if (cancelReason) historyItem.note = cancelReason

        if (!update.$push) update.$push = {}
        update.$push.statusHistory = historyItem

        if (status === BOOKING_STATUS.REQUEST_BOOKING) {
            const expireHours = getRequestBookingExpireHours(requestedByRole)
            updateData.requestedByRole = requestedByRole || "user"
            updateData.requestExpiresAt = new Date(now.getTime() + expireHours * 60 * 60 * 1000)
        } else {
            update.$unset = { requestExpiresAt: "" }
        }

        if (status === BOOKING_STATUS.CANCEL || status === "cancel") {
            updateData.cancelledAt = now
            updateData.cancelReason = cancelReason || "No reason provided"
            updateData.cancelledBy = actorInfo

            const prevPaid = Number(currentDoc.paidAmount !== undefined ? currentDoc.paidAmount : (currentDoc.advanceAmount || 0))
            const refundAmt = Number(req.body.refundAmount || 0)

            if (refundAmt > 0) {
                if (refundAmt > prevPaid) {
                    return res.status(400).send({
                        message: `Refund amount (৳${refundAmt.toLocaleString()}) cannot exceed total paid amount (৳${prevPaid.toLocaleString()}).`
                    })
                }
                updateData.refundAmount = refundAmt
                const newPaid = Math.max(0, prevPaid - refundAmt)
                updateData.paidAmount = newPaid
                updateData.dueAmount = Math.max(0, getBookingTotal(currentDoc) - newPaid)

                const refundEntry = {
                    amount: -refundAmt,
                    refundAmount: refundAmt,
                    paymentMethod: req.body.refundPaymentMethod || req.body.paymentMethod || "Refund",
                    reference: updateData.reference || currentDoc.reference || "",
                    transactionId: req.body.refundTransactionId || updateData.transactionId || "",
                    note: `Refund of ৳${refundAmt.toLocaleString()} issued upon cancellation. Reason: ${cancelReason || "Cancellation"}`,
                    date: now,
                    collectedBy: actorInfo
                }
                if (!update.$push) update.$push = {}
                update.$push.paymentHistory = refundEntry
                historyItem.note = `${cancelReason || "Reservation cancelled"} (Refunded: ৳${refundAmt.toLocaleString()})`
            }
        }
    }

    // Record payment entry in paymentHistory if paidAmount was recorded/increased
    if (updateData.paidAmount !== undefined) {
        const prevPaid = Number(currentDoc.paidAmount !== undefined ? currentDoc.paidAmount : (currentDoc.advanceAmount || 0))
        const newPaid = Number(updateData.paidAmount)
        const diff = newPaid - prevPaid
        if (diff > 0) {
            const method = req.body.paymentMethod || updateData.paymentMethod || currentDoc.paymentMethod || "Cash"
            const trx = updateData.transactionId || (method === "Cash" ? "Cash / Direct" : "")
            const payEntry = {
                amount: diff,
                paymentMethod: method,
                reference: updateData.reference || currentDoc.reference || "",
                transactionId: trx,
                note: updateData.notes || `Payment of ৳${diff.toLocaleString()} recorded`,
                date: now,
                collectedBy: actorInfo
            }
            if (!update.$push) update.$push = {}
            update.$push.paymentHistory = payEntry
        }
    }

    const result = await bookingCollection.updateOne(query, update)
    if (status) result.status = status
    res.send(result)
})

app.delete("/booking/:id", verifyFBToken, verifyAdmin, async (req, res) => {
    const { id } = req.params
    const query = { _id: new ObjectId(id) }
    const result = await bookingCollection.deleteOne(query)
    res.send(result)
})

// Dedicated Reservation Voucher / Printable Invoice Data API
app.get("/booking/:id/reservation-voucher", verifyFBToken, async (req, res) => {
    try {
        const { id } = req.params
        const objectId = toObjectId(id)
        const query = objectId ? { _id: objectId } : { bookingId: id }

        const booking = await bookingCollection.findOne(query)
        if (!booking) {
            return res.status(404).send({ message: "Reservation not found." })
        }

        // Format & enrich room lines
        const rawRooms = Array.isArray(booking.rooms) && booking.rooms.length > 0
            ? booking.rooms
            : [{
                categoryName: booking.category || booking.categoryName || "Room",
                checkIn: booking.checkIn,
                checkOut: booking.checkOut,
                pricePerNight: booking.pricePerNight || booking.price || 0,
                adults: booking.adults || 2,
                babies: booking.babies || 0,
                roomNo: booking.roomNo || ""
            }]

        const roomRows = rawRooms.map(r => {
            const checkIn = r.checkIn || booking.checkIn
            const checkOut = r.checkOut || booking.checkOut
            let nights = 1
            if (checkIn && checkOut) {
                const start = new Date(checkIn)
                const end = new Date(checkOut)
                if (!isNaN(start.getTime()) && !isNaN(end.getTime()) && end > start) {
                    nights = Math.max(1, Math.ceil((end - start) / (1000 * 60 * 60 * 24)))
                }
            }
            const tariff = Number(r.pricePerNight || r.price || 0)
            const subtotal = tariff * nights
            return {
                roomType: r.categoryName || r.category || r.name || "Room Category",
                roomNo: r.roomNo || "",
                arrivalDate: checkIn,
                departureDate: checkOut,
                roomTariff: tariff,
                roomQty: 1,
                roomNights: nights,
                total: subtotal
            }
        })

        const discountAmount = getBookingDiscount(booking)
        const payableTotal = getBookingTotal(booking)
        const paidAmount = getBookingPaidAmount(booking)
        const dueAmount = getBookingDueAmount(booking)

        const totalAdults = rawRooms.reduce((sum, r) => sum + Number(r.adults || 1), 0)
        const totalChildren = rawRooms.reduce((sum, r) => sum + Number(r.babies || 0), 0)
        const totalNights = roomRows.reduce((sum, r) => Math.max(sum, r.roomNights), 0)

        const creator = booking.reference || booking.changedBy?.name || "Front Desk"

        const voucherData = {
            resort: {
                name: "MIAMI BEACH RESORT",
                address: "Marin Drive Road,South Kolatoli, Cox's Bazar. 4700",
                hotlines: ["+8801341849375", "+8801341849376"],
                email: "Info.miamibeachresort@gmail.com",
                checkInTime: "13:00:00 Hours",
                checkOutTime: "11:00:00 Hours"
            },
            reservation: {
                id: booking._id,
                bookingId: booking.bookingId || id,
                status: booking.status || "confirmed",
                printDate: new Date(),
                createdDate: booking.createdAt || new Date(),
                creator: creator,
                guest: {
                    name: booking.name || "Guest",
                    email: booking.userEmail || booking.email || "",
                    mobile: booking.mobile || "",
                    address: booking.address || "",
                    organization: booking.organization || ""
                },
                details: {
                    arrivalDate: booking.checkIn || roomRows[0]?.arrivalDate,
                    departureDate: booking.checkOut || roomRows[0]?.departureDate,
                    mode: "Self",
                    totalNights: totalNights,
                    guestCount: {
                        adults: totalAdults,
                        children: totalChildren,
                        total: totalAdults + totalChildren
                    },
                    airportPickUp: "NO",
                    flightEta: "",
                    airportDrop: "NO",
                    flightEtd: ""
                },
                rooms: roomRows,
                financials: {
                    totalAmount: payableTotal,
                    paidAmount,
                    dueAmount,
                    discountAmount,
                    extraService: booking.extraService || "",
                    extraServiceCost: Number(booking.extraServiceCost || 0),
                    extraServices: Array.isArray(booking.extraServices) ? booking.extraServices : [],
                    paymentMethod: booking.paymentMethod || "M-Banking Advance",
                    paymentHistory: Array.isArray(booking.paymentHistory) ? booking.paymentHistory : []
                },
                extraService: booking.extraService || "",
                extraServiceCost: Number(booking.extraServiceCost || 0),
                extraServices: Array.isArray(booking.extraServices) ? booking.extraServices : [],
                paymentHistory: Array.isArray(booking.paymentHistory) ? booking.paymentHistory : [],
                reference: creator,
                notes: booking.notes || ""
            }
        }

        res.send(voucherData)
    } catch (err) {
        console.error("Voucher API error:", err)
        res.status(500).send({ message: "Failed to generate voucher data." })
    }
})

// Add due payment to a booking
app.post("/booking/:id/add-payment", verifyFBToken, async (req, res) => {
    try {
        const { id } = req.params
        const { amount, paymentMethod, reference, transactionId, note, collectedBy } = req.body
        const payAmount = Number(amount)

        if (isNaN(payAmount) || payAmount <= 0) {
            return res.status(400).send({ message: "Valid payment amount is required." })
        }

        const objectId = toObjectId(id)
        const query = objectId ? { _id: objectId } : { bookingId: id }

        const booking = await bookingCollection.findOne(query)
        if (!booking) {
            return res.status(404).send({ message: "Reservation not found." })
        }

        if (booking.status === BOOKING_STATUS.REQUEST_BOOKING || booking.status === "pending") {
            return res.status(400).send({
                message: "Payment cannot be collected on a pending request booking. Please confirm the booking first."
            })
        }

        const currentDue = getBookingDueAmount(booking)
        if (currentDue <= 0) {
            return res.status(400).send({ message: "This reservation has no outstanding due balance." })
        }

        if (payAmount > currentDue) {
            return res.status(400).send({
                message: `Payment amount (৳${payAmount.toLocaleString()}) cannot be greater than the current due balance (৳${currentDue.toLocaleString()}).`
            })
        }

        const now = new Date()
        const actorInfo = collectedBy || {
            email: req.decodedEmail || "",
            name: "Staff / Admin",
            role: "admin"
        }

        const paymentEntry = {
            amount: payAmount,
            paymentMethod: paymentMethod || "Cash",
            reference: reference || "",
            transactionId: transactionId || "",
            note: note || "",
            date: now,
            collectedBy: actorInfo
        }

        const statusAuditEntry = {
            status: "payment_collected",
            time: now,
            changedBy: actorInfo,
            note: `Collected due payment of ৳${payAmount.toLocaleString()} via ${paymentMethod || "Cash"}${transactionId ? ` (Trx: ${transactionId})` : ""}`
        }

        const prevPaid = Number(booking.paidAmount !== undefined ? booking.paidAmount : (booking.advanceAmount || 0))
        const editAuditEntry = {
            timestamp: now,
            changedBy: actorInfo,
            summary: [`Collected due payment of ৳${payAmount.toLocaleString()} via ${paymentMethod || "Cash"}`],
            changes: [
                {
                    field: "paidAmount",
                    label: "Payment Collected",
                    oldValue: `৳${prevPaid.toLocaleString()}`,
                    newValue: `৳${(prevPaid + payAmount).toLocaleString()}`,
                    description: `Collected due payment of ৳${payAmount.toLocaleString()} via ${paymentMethod || "Cash"}${transactionId ? ` (Trx: ${transactionId})` : ""}`
                }
            ]
        }

        const result = await bookingCollection.findOneAndUpdate(
            query,
            {
                $inc: { paidAmount: payAmount },
                $push: {
                    paymentHistory: paymentEntry,
                    statusHistory: statusAuditEntry,
                    editHistory: editAuditEntry
                },
                $set: {
                    updatedAt: now,
                    ...(paymentMethod ? { paymentMethod } : {}),
                    ...(transactionId ? { transactionId } : {})
                }
            },
            { returnDocument: "after" }
        )

        // Recalculate accurate dueAmount after payment increment
        const netPayable = getBookingTotal(result)
        const totalPaid = getBookingPaidAmount(result)
        const newDue = Math.max(0, netPayable - totalPaid)
        await bookingCollection.updateOne(query, { $set: { dueAmount: newDue } })
        result.dueAmount = newDue

        res.send(result)
    } catch (err) {
        console.error("Add payment error:", err)
        res.status(500).send({ message: "Failed to process payment." })
    }
})

// OUT OF ORDER (MAINTENANCE) ENDPOINTS ..............................................
app.get("/out-of-order", async (req, res) => {
    try {
        const result = await outOfOrderCollection.find({ status: "active" }).sort({ startDate: -1 }).toArray()
        res.send(result)
    } catch (err) {
        console.error("Fetch out of order error:", err)
        res.status(500).send({ message: "Failed to fetch out of order records." })
    }
})

app.post("/out-of-order", verifyFBToken, verifyAdminOrManager, async (req, res) => {
    try {
        const { roomNo, categoryId, categoryName, startDate, endDate, reason, notes, createdBy } = req.body
        if (!roomNo || !startDate || !endDate) {
            return res.status(400).send({ message: "Room number, Start date, and End date are required." })
        }

        if (new Date(startDate) >= new Date(endDate)) {
            return res.status(400).send({ message: "End date must be after start date." })
        }

        const cleanRoomNo = String(roomNo).trim()

        // Prevent setting room out of order if an active booking is overlapping
        const conflictingBooking = await bookingCollection.findOne({
            status: { $in: ACTIVE_BOOKING_STATUSES },
            $or: [
                {
                    rooms: {
                        $elemMatch: {
                            roomNo: cleanRoomNo,
                            checkIn: { $lt: endDate },
                            checkOut: { $gt: startDate }
                        }
                    }
                },
                {
                    roomNo: cleanRoomNo,
                    checkIn: { $lt: endDate },
                    checkOut: { $gt: startDate }
                }
            ]
        })

        if (conflictingBooking) {
            return res.status(409).send({
                message: `Room ${cleanRoomNo} already has an active reservation (${conflictingBooking.bookingId} - ${conflictingBooking.name}) from ${startDate} to ${endDate}. Please relocate or cancel the booking first.`
            })
        }

        // If this room already has an active Out of Order record, update it instead of creating duplicates
        const existingActiveOOO = await outOfOrderCollection.findOne({
            roomNo: cleanRoomNo,
            status: "active"
        })

        if (existingActiveOOO) {
            const updateDoc = {
                $set: {
                    startDate,
                    endDate,
                    reason: reason || existingActiveOOO.reason || "Maintenance / Repair",
                    notes: notes !== undefined ? notes : (existingActiveOOO.notes || ""),
                    categoryId: categoryId || existingActiveOOO.categoryId || "",
                    categoryName: categoryName || existingActiveOOO.categoryName || "",
                    updatedAt: new Date(),
                    updatedBy: {
                        email: req.decodedEmail || "",
                        name: createdBy?.name || "Staff / Admin",
                        role: createdBy?.role || "admin"
                    }
                }
            }
            await outOfOrderCollection.updateOne({ _id: existingActiveOOO._id }, updateDoc)
            const updated = await outOfOrderCollection.findOne({ _id: existingActiveOOO._id })
            return res.send(updated)
        }

        const doc = {
            roomNo: cleanRoomNo,
            categoryId: categoryId || "",
            categoryName: categoryName || "",
            startDate,
            endDate,
            reason: reason || "Maintenance / Repair",
            notes: notes || "",
            status: "active",
            createdAt: new Date(),
            createdBy: createdBy || {
                email: req.decodedEmail || "",
                name: "Staff / Admin",
                role: "admin"
            }
        }

        const result = await outOfOrderCollection.insertOne(doc)
        doc._id = result.insertedId
        res.send(doc)
    } catch (err) {
        console.error("Create out of order error:", err)
        res.status(500).send({ message: "Failed to mark room as out of order." })
    }
})

app.patch("/out-of-order/:id", verifyFBToken, verifyAdminOrManager, async (req, res) => {
    try {
        const { id } = req.params
        const { status, resolvedBy, reason, notes, startDate, endDate } = req.body
        const objectId = toObjectId(id)
        const query = objectId ? { _id: objectId } : { _id: id }

        const existingRecord = await outOfOrderCollection.findOne(query)
        if (!existingRecord) {
            return res.status(404).send({ message: "Out of order record not found." })
        }

        const targetStartDate = startDate || existingRecord.startDate
        const targetEndDate = endDate || existingRecord.endDate
        const roomNo = existingRecord.roomNo

        if (startDate || endDate) {
            if (new Date(targetStartDate) >= new Date(targetEndDate)) {
                return res.status(400).send({ message: "End date must be after start date." })
            }

            // Prevent changing dates if an active booking is overlapping
            const conflictingBooking = await bookingCollection.findOne({
                status: { $in: ACTIVE_BOOKING_STATUSES },
                $or: [
                    {
                        rooms: {
                            $elemMatch: {
                                roomNo: roomNo,
                                checkIn: { $lt: targetEndDate },
                                checkOut: { $gt: targetStartDate }
                            }
                        }
                    },
                    {
                        roomNo: roomNo,
                        checkIn: { $lt: targetEndDate },
                        checkOut: { $gt: targetStartDate }
                    }
                ]
            })

            if (conflictingBooking) {
                return res.status(409).send({
                    message: `Cannot update maintenance dates: Room ${roomNo} has an active reservation (${conflictingBooking.bookingId} - ${conflictingBooking.name}) from ${targetStartDate} to ${targetEndDate}.`
                })
            }
        }

        const updateDoc = {
            $set: {
                ...(status ? { status } : {}),
                ...(status === "resolved" ? {
                    resolvedAt: new Date(),
                    resolvedBy: resolvedBy || {
                        email: req.decodedEmail || "",
                        name: "Staff / Admin",
                        role: "admin"
                    }
                } : {}),
                ...(startDate ? { startDate } : {}),
                ...(endDate ? { endDate } : {}),
                ...(reason ? { reason } : {}),
                ...(notes !== undefined ? { notes } : {}),
                updatedAt: new Date()
            }
        }

        const result = await outOfOrderCollection.updateOne(query, updateDoc)
        const updated = await outOfOrderCollection.findOne(query)
        res.send(updated || result)
    } catch (err) {
        console.error("Update out of order error:", err)
        res.status(500).send({ message: "Failed to update out of order status." })
    }
})

app.delete("/out-of-order/:id", verifyFBToken, verifyAdminOrManager, async (req, res) => {
    try {
        const { id } = req.params
        const objectId = toObjectId(id)
        const query = objectId ? { _id: objectId } : { _id: id }
        const result = await outOfOrderCollection.deleteOne(query)
        res.send(result)
    } catch (err) {
        console.error("Delete out of order error:", err)
        res.status(500).send({ message: "Failed to delete out of order record." })
    }
})
// CATEGORY & ROOM ..............................................
app.get("/categoryandroom", async (req, res) => {
    try {
        await applyDuePriceSchedules()
        const { search, category, sort } = req.query
        const match = {}

        if (category && typeof category === 'string' && category.trim()) {
            match.name = category.trim()
        }

        if (search && typeof search === 'string' && search.trim()) {
            const cleanSearch = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            const sRegex = { $regex: cleanSearch, $options: "i" }
            const searchOr = [
                { name: sRegex },
                { amenities: sRegex },
                { description: sRegex }
            ]
            if (match.name) {
                match.$and = [
                    { name: match.name },
                    { $or: searchOr }
                ]
                delete match.name
            } else {
                match.$or = searchOr
            }
        }

        const pipeline = []
        if (Object.keys(match).length > 0) {
            pipeline.push({ $match: match })
        }

        if (sort === "price-asc" || sort === "price-desc") {
            pipeline.push({
                $addFields: {
                    numericPrice: {
                        $convert: {
                            input: "$price",
                            to: "double",
                            onError: 0,
                            onNull: 0
                        }
                    }
                }
            })
            pipeline.push({
                $sort: { numericPrice: sort === "price-asc" ? 1 : -1 }
            })
        } else if (sort === "name-asc") {
            pipeline.push({
                $sort: { name: 1 }
            })
        }

        let result
        if (pipeline.length > 0) {
            result = await categoryAndRoomCollection.aggregate(pipeline).toArray()
        } else {
            result = await categoryAndRoomCollection.find().toArray()
        }

        res.send(result)
    } catch (err) {
        console.error("Get categoryandroom error:", err)
        res.status(500).send({ message: "Failed to fetch categories" })
    }
})

app.get("/categoryandroom/:id", async (req, res) => {
    const { id } = req.params
    await applyDuePriceSchedules(id)
    const query = toObjectId(id) ? { _id: toObjectId(id) } : { _id: id }
    let result = await categoryAndRoomCollection.findOne(query)
    if (!result) {
        result = await roomCollection.findOne(query)
    }
    if (!result) {
        return res.status(404).send({ message: "Category not found" })
    }
    res.send(result)
})

app.patch("/categoryandroom/:id", verifyFBToken, verifyAdmin, async (req, res) => {
    const { id } = req.params
    const data = req.body
    const query = toObjectId(id) ? { _id: toObjectId(id) } : { _id: id }

    // If updating images, delete any removed images from Cloudinary
    if (data.images !== undefined || data.imageUrl !== undefined || data.imagePublicId !== undefined) {
        try {
            const existingCat = await categoryAndRoomCollection.findOne(query)
            if (existingCat) {
                const oldIds = collectCloudinaryPublicIds(existingCat)
                const newIds = new Set(collectCloudinaryPublicIds(data))
                const removedIds = oldIds.filter(pId => !newIds.has(pId))

                if (removedIds.length > 0) {
                    await Promise.all(removedIds.map(async (pId) => {
                        try {
                            await cloudinary.uploader.destroy(pId)
                        } catch (err) {
                            console.log("Cloudinary delete error for removed category image", pId, ":", err.message)
                        }
                    }))
                }
            }
        } catch (e) {
            console.log("Error cleaning up removed category images:", e.message)
        }
    }

    data.updatedAt = new Date()
    const update = { $set: data }
    const result = await categoryAndRoomCollection.updateOne(query, update)
    res.send(result)
})

app.post("/categoryandroom", verifyFBToken, verifyAdmin, async (req, res) => {
    const data = req.body
    data.createdAt = new Date()
    data.updatedAt = new Date()
    const result = await categoryAndRoomCollection.insertOne(data)
    res.send(result)
})

// Check if ANY room under a category is available for given dates
app.get("/check-category-availability", async (req, res) => {
    const { categoryId, checkIn, checkOut } = req.query
    if (!categoryId || !checkIn || !checkOut) {
        return res.status(400).send({ available: false, message: "categoryId, checkIn and checkOut are required" })
    }

    // Get the category to find its room numbers
    const catObjectId = toObjectId(categoryId)
    if (!catObjectId) return res.status(400).send({ available: false, message: "Invalid categoryId" })

    const category = await categoryAndRoomCollection.findOne({ _id: catObjectId })
    if (!category) return res.status(404).send({ available: false, message: "Category not found" })

    const cleanRoomNumbers = (Array.isArray(category.roomNumbers) ? category.roomNumbers : [])
        .map(r => String(r).trim())
        .filter(Boolean)

    if (cleanRoomNumbers.length === 0) {
        return res.send({ available: true, message: "Category has rooms available." })
    }

    // For each physical room in category, check Out of Order and booking conflicts
    let availableRoomCount = 0
    for (const roomNo of cleanRoomNumbers) {
        // 1. Check Out of Order maintenance
        const isOOO = await outOfOrderCollection.findOne({
            status: "active",
            roomNo,
            startDate: { $lt: checkOut },
            endDate: { $gt: checkIn }
        })
        if (isOOO) continue

        // 2. Check active booking reservations
        const isBooked = await bookingCollection.findOne({
            status: { $in: ACTIVE_BOOKING_STATUSES },
            $or: [
                {
                    rooms: {
                        $elemMatch: {
                            roomNo,
                            checkIn: { $lt: checkOut },
                            checkOut: { $gt: checkIn }
                        }
                    }
                },
                {
                    roomNo,
                    checkIn: { $lt: checkOut },
                    checkOut: { $gt: checkIn }
                }
            ]
        })
        if (isBooked) continue

        availableRoomCount++
    }

    if (availableRoomCount > 0) {
        res.send({
            available: true,
            availableCount: availableRoomCount,
            message: `${availableRoomCount} room(s) available in this category for the selected dates.`
        })
    } else {
        res.send({
            available: false,
            availableCount: 0,
            message: `No rooms are available in "${category.name}" from ${checkIn} to ${checkOut} (all rooms are reserved or out of order for maintenance).`
        })
    }
})

app.delete('/categoryandroom/:id', verifyFBToken, verifyAdminOnly, async (req, res) => {
    const { id } = req.params
    const query = toObjectId(id) ? { _id: toObjectId(id) } : { _id: id }

    // Get the category first to find all Cloudinary images to delete
    const category = await categoryAndRoomCollection.findOne(query)

    if (category) {
        const publicIdsToDelete = collectCloudinaryPublicIds(category)
        await Promise.all(publicIdsToDelete.map(async (pId) => {
            try {
                await cloudinary.uploader.destroy(pId)
            } catch (err) {
                console.log("Cloudinary delete error for category image", pId, ":", err.message)
            }
        }))
    }

    const result = await categoryAndRoomCollection.deleteOne(query)
    res.send(result)
})

// --- Extra Services Endpoints ---
app.get("/extra-services", async (req, res) => {
    try {
        const result = await extraServicesCollection.find({}).sort({ createdAt: -1 }).toArray()
        res.send(result)
    } catch (error) {
        res.status(500).send({ message: error.message })
    }
})

app.post("/extra-services", verifyFBToken, verifyAdmin, async (req, res) => {
    try {
        const service = {
            name: req.body.name,
            price: Number(req.body.price || 0),
            currency: req.body.currency || "৳",
            billingType: req.body.billingType || "Per Night",
            description: req.body.description || "",
            active: req.body.active !== undefined ? req.body.active : true,
            popular: !!req.body.popular,
            createdAt: new Date()
        }
        if (req.body.category) service.category = req.body.category
        const result = await extraServicesCollection.insertOne(service)
        res.send({ acknowledged: true, insertedId: result.insertedId, ...service })
    } catch (error) {
        res.status(500).send({ message: error.message })
    }
})

app.patch("/extra-services/:id", verifyFBToken, verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params
        const query = toObjectId(id) ? { $or: [{ _id: toObjectId(id) }, { _id: id }] } : { _id: id }
        const update = { $set: {} }
        if (req.body.active !== undefined) update.$set.active = req.body.active
        if (req.body.name !== undefined) update.$set.name = req.body.name
        if (req.body.category !== undefined) update.$set.category = req.body.category
        if (req.body.price !== undefined) update.$set.price = Number(req.body.price || 0)
        if (req.body.billingType !== undefined) update.$set.billingType = req.body.billingType
        if (req.body.description !== undefined) update.$set.description = req.body.description
        const result = await extraServicesCollection.updateOne(query, update)
        res.send(result)
    } catch (error) {
        res.status(500).send({ message: error.message })
    }
})

app.delete("/extra-services/:id", verifyFBToken, verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params
        const query = toObjectId(id) ? { $or: [{ _id: toObjectId(id) }, { _id: id }] } : { _id: id }
        const result = await extraServicesCollection.deleteOne(query)
        res.send(result)
    } catch (error) {
        res.status(500).send({ message: error.message })
    }
})

// --- Settings: Extra Services Billing Types Endpoints ---
const DEFAULT_BILLING_TYPES = [
    { id: "per_night", name: "Per Night", unitLabel: "night", description: "Billed per night of stay" },
    { id: "per_person", name: "Per Person", unitLabel: "person", description: "Billed per guest count" },
    { id: "per_quantity", name: "Per Quantity", unitLabel: "item", description: "Billed per item / quantity" },
    { id: "one_time", name: "One-time", unitLabel: "time", description: "Fixed one-time service fee" }
]

const getOrSeedBillingTypes = async () => {
    let doc = await settingsCollection.findOne({ _id: "general_settings" })
    if (!doc) {
        doc = await settingsCollection.findOne({ "extraServices.billingType": { $exists: true } })
    }
    if (!doc || !Array.isArray(doc?.extraServices?.billingType) || doc.extraServices.billingType.length === 0) {
        const initialDoc = {
            _id: "general_settings",
            extraServices: {
                billingType: DEFAULT_BILLING_TYPES
            },
            updatedAt: new Date()
        }
        await settingsCollection.updateOne(
            { _id: "general_settings" },
            { $set: initialDoc },
            { upsert: true }
        )
        return DEFAULT_BILLING_TYPES
    }
    return doc.extraServices.billingType
}

app.get("/settings/extra-services/billing-types", async (req, res) => {
    try {
        const billingTypes = await getOrSeedBillingTypes()
        res.send(billingTypes)
    } catch (error) {
        console.error("Failed to load billing types:", error)
        res.status(500).send({ message: error.message })
    }
})

app.post("/settings/extra-services/billing-types", verifyFBToken, verifyAdmin, async (req, res) => {
    try {
        const { name, unitLabel, description } = req.body || {}
        const cleanName = String(name || "").trim()
        if (!cleanName) {
            return res.status(400).send({ message: "Billing type name is required." })
        }

        const currentTypes = await getOrSeedBillingTypes()
        const exists = currentTypes.some(bt => {
            const btName = typeof bt === 'string' ? bt : bt.name
            return String(btName).toLowerCase() === cleanName.toLowerCase()
        })
        if (exists) {
            return res.status(400).send({ message: `Billing type "${cleanName}" already exists.` })
        }

        const newType = {
            id: `bt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name: cleanName,
            unitLabel: String(unitLabel || "unit").trim() || "unit",
            description: String(description || "").trim(),
            createdAt: new Date()
        }

        await settingsCollection.updateOne(
            { _id: "general_settings" },
            {
                $push: { "extraServices.billingType": newType },
                $set: { updatedAt: new Date() }
            },
            { upsert: true }
        )

        const updated = await getOrSeedBillingTypes()
        res.send({ acknowledged: true, insertedType: newType, billingTypes: updated })
    } catch (error) {
        console.error("Failed to add billing type:", error)
        res.status(500).send({ message: error.message })
    }
})

app.patch("/settings/extra-services/billing-types/:id", verifyFBToken, verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params
        const { name, unitLabel, description } = req.body || {}
        const cleanName = name !== undefined ? String(name).trim() : undefined
        if (cleanName !== undefined && !cleanName) {
            return res.status(400).send({ message: "Billing type name cannot be empty." })
        }

        const currentTypes = await getOrSeedBillingTypes()
        const targetIndex = currentTypes.findIndex(bt => {
            if (typeof bt === 'string') return bt === id
            return String(bt.id) === String(id) || String(bt.name).toLowerCase() === String(id).toLowerCase()
        })

        if (targetIndex === -1) {
            return res.status(404).send({ message: "Billing type not found." })
        }

        const oldType = currentTypes[targetIndex]
        const oldName = typeof oldType === 'string' ? oldType : oldType.name

        if (cleanName && cleanName.toLowerCase() !== oldName.toLowerCase()) {
            const nameExists = currentTypes.some((bt, idx) => {
                if (idx === targetIndex) return false
                const btName = typeof bt === 'string' ? bt : bt.name
                return String(btName).toLowerCase() === cleanName.toLowerCase()
            })
            if (nameExists) {
                return res.status(400).send({ message: `Another billing type named "${cleanName}" already exists.` })
            }
        }

        const updatedType = {
            ...(typeof oldType === 'object' ? oldType : { id: `bt_${Date.now()}` }),
            name: cleanName !== undefined ? cleanName : oldName,
            unitLabel: unitLabel !== undefined ? String(unitLabel).trim() : (oldType.unitLabel || "unit"),
            description: description !== undefined ? String(description).trim() : (oldType.description || ""),
            updatedAt: new Date()
        }

        currentTypes[targetIndex] = updatedType

        await settingsCollection.updateOne(
            { _id: "general_settings" },
            {
                $set: {
                    "extraServices.billingType": currentTypes,
                    updatedAt: new Date()
                }
            },
            { upsert: true }
        )

        if (cleanName && cleanName !== oldName) {
            await extraServicesCollection.updateMany(
                { billingType: oldName },
                { $set: { billingType: cleanName } }
            )
        }

        res.send({ acknowledged: true, updatedType, billingTypes: currentTypes })
    } catch (error) {
        console.error("Failed to update billing type:", error)
        res.status(500).send({ message: error.message })
    }
})

app.delete("/settings/extra-services/billing-types/:id", verifyFBToken, verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params
        const currentTypes = await getOrSeedBillingTypes()
        const targetIndex = currentTypes.findIndex(bt => {
            if (typeof bt === 'string') return bt === id
            return String(bt.id) === String(id) || String(bt.name).toLowerCase() === String(id).toLowerCase()
        })

        if (targetIndex === -1) {
            return res.status(404).send({ message: "Billing type not found." })
        }

        const targetType = currentTypes[targetIndex]
        const targetName = typeof targetType === 'string' ? targetType : targetType.name

        const inUseCount = await extraServicesCollection.countDocuments({ billingType: targetName })
        if (inUseCount > 0 && !req.query.force) {
            return res.status(400).send({
                message: `Cannot delete "${targetName}" because it is currently assigned to ${inUseCount} extra service(s). Please edit or reassign those services first.`,
                inUseCount
            })
        }

        const updatedTypes = currentTypes.filter((_, idx) => idx !== targetIndex)

        await settingsCollection.updateOne(
            { _id: "general_settings" },
            {
                $set: {
                    "extraServices.billingType": updatedTypes,
                    updatedAt: new Date()
                }
            },
            { upsert: true }
        )

        res.send({ acknowledged: true, deletedName: targetName, billingTypes: updatedTypes })
    } catch (error) {
        console.error("Failed to delete billing type:", error)
        res.status(500).send({ message: error.message })
    }
})

// ADMIN OVERVIEW & INCOME ..............................................
app.get("/admin/overview", verifyFBToken, verifyAdmin, async (req, res) => {
    const now = new Date()
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const currentMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)

    const dataFromBookings = (await bookingCollection.aggregate([{
        $facet: {
            statusCounts: [
                { $group: { _id: "$status", count: { $sum: 1 } } }
            ],
            bookingsPerDay: [
                {
                    $group: {
                        _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
                        count: { $sum: 1 }
                    }
                },
                { $sort: { _id: 1 } },
                { $limit: 7 }
            ]
        }
    }]).toArray())[0]

    const allBookings = await bookingCollection.find().toArray()
    const hydratedBookings = await hydrateBookingsWithRooms(allBookings, roomCollection, categoryAndRoomCollection)
    const revenueBookings = hydratedBookings.filter(isRevenueBooking)
    const totalRevenue = revenueBookings.reduce((total, booking) => total + getBookingRevenue(booking), 0)

    const monthlyRevenueBookings = revenueBookings.filter(booking => {
        const bookingDate = booking.cancelledAt ? new Date(booking.cancelledAt) : (booking.createdAt ? new Date(booking.createdAt) : null)
        if (bookingDate && bookingDate >= currentMonthStart && bookingDate <= currentMonthEnd) return true
        const firstRoom = getBookingRooms(booking)[0]
        if (firstRoom?.checkIn) {
            const cIn = new Date(firstRoom.checkIn)
            if (cIn >= currentMonthStart && cIn <= currentMonthEnd) return true
        }
        return false
    })
    const monthlyRevenue = monthlyRevenueBookings.reduce((total, booking) => total + getBookingRevenue(booking), 0)

    const roomCountMap = {}
    const roomRevenueMap = {}

    revenueBookings.forEach(booking => {
        const isCancelled = CANCEL_STATUSES.includes(booking.status)
        const rooms = getBookingRooms(booking)
        if (!rooms.length) return

        if (isCancelled) {
            const retainedPaid = Number(booking.paidAmount || 0)
            if (retainedPaid > 0) {
                const totalRoomPrice = rooms.reduce((sum, r) => sum + (getRoomTotal(r) || 1), 0) || 1
                rooms.forEach(room => {
                    const label = room.room?.name || room.room?.category || room.categoryName || room.roomName || room.roomCategory || "Room"
                    const portion = ((getRoomTotal(room) || 1) / totalRoomPrice) * retainedPaid
                    roomRevenueMap[label] = (roomRevenueMap[label] || 0) + portion
                })
            }
        } else {
            rooms.forEach(room => {
                const label = room.room?.name || room.room?.category || room.categoryName || room.roomName || room.roomCategory || "Room"
                roomCountMap[label] = (roomCountMap[label] || 0) + 1
                roomRevenueMap[label] = (roomRevenueMap[label] || 0) + getRoomTotal(room)
            })
        }
    })

    const bookingsPerRoom = Object.entries(roomCountMap)
        .map(([roomName, count]) => ({ _id: roomName, count }))
        .sort((a, b) => b.count - a.count)

    const revenuePerRoom = Object.entries(roomRevenueMap)
        .map(([roomName, revenue]) => ({ roomName, revenue }))
        .sort((a, b) => b.revenue - a.revenue)

    const statusMap = {}
    dataFromBookings.statusCounts.forEach(s => { statusMap[s._id] = s.count })

    const result = {
        totalBookings: Object.values(statusMap).reduce((total, count) => total + count, 0),
        confirmedCount: (statusMap.booking_confirmed || 0) + (statusMap.checked_id || 0) + (statusMap.checked_out || 0) + (statusMap.confirmed || 0),
        pendingCount: (statusMap.request_booking || 0) + (statusMap.pending || 0),
        cancelledCount: (statusMap.cancel || 0) + (statusMap.cancelled || 0),
        totalRevenue,
        monthlyRevenue,
        currentMonthName: now.toLocaleString('default', { month: 'long', year: 'numeric' }),
        bookingsPerDay: dataFromBookings.bookingsPerDay,
        bookingsPerRoom,
        revenuePerRoom
    }
    res.send(result)
})

// Detailed Income Analytics (Supports Server-Side Pagination with limit & skip, powered by MongoDB Aggregation)
app.get("/admin/income-breakdown", verifyFBToken, verifyAdmin, async (req, res) => {
    try {
        const {
            startDate,
            endDate,
            limit: reqLimit,
            skip: reqSkip,
            search,
            category,
            role,
            worker,
            guestType,
            room,
            bookingStatus,
            export: reqExport
        } = req.query

        const isExport = reqExport === "true" || reqExport === true
        const limit = reqLimit !== undefined ? Math.max(1, parseInt(reqLimit, 10) || 25) : 25
        const skip = reqSkip !== undefined ? Math.max(0, parseInt(reqSkip, 10) || 0) : 0

        // 1. Initial Status Filter
        let statusMatch = {}
        if (bookingStatus && bookingStatus !== "all") {
            if (bookingStatus === "confirmed") {
                statusMatch = { status: { $in: ["booking_confirmed", "confirmed"] } }
            } else if (bookingStatus === "checked_in") {
                statusMatch = { status: { $in: ["checked_in", "checked_id"] } }
            } else if (bookingStatus === "checked_out") {
                statusMatch = { status: "checked_out" }
            } else if (bookingStatus === "cancelled") {
                statusMatch = { status: { $in: CANCEL_STATUSES }, paidAmount: { $gt: 0 } }
            } else if (bookingStatus === "request_booking") {
                statusMatch = { status: "request_booking" }
            }
        } else {
            statusMatch = {
                $or: [
                    { status: { $in: CONFIRMED_STATUSES } },
                    { status: { $in: CANCEL_STATUSES }, paidAmount: { $gt: 0 } }
                ]
            }
        }

        const initialMatch = { ...statusMatch }

        // Early pre-filters before unwinding to reduce document count
        if (category && category !== "all") {
            initialMatch["rooms.categoryName"] = category
        }
        if (room && room !== "all") {
            initialMatch["rooms.roomNo"] = String(room).trim()
        }
        if (role && role !== "all") {
            const roleRegex = new RegExp(`^${role}$`, 'i')
            initialMatch.$or = [
                { requestedByRole: { $regex: roleRegex } },
                { "bookedBy.role": { $regex: roleRegex } },
                { "createdBy.role": { $regex: roleRegex } },
                { "changedBy.role": { $regex: roleRegex } }
            ]
        }
        if (worker && worker !== "all") {
            const wRegex = new RegExp(`^${worker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
            initialMatch.$or = [
                { reference: { $regex: wRegex } },
                { "bookedBy.name": { $regex: wRegex } },
                { "bookedBy.email": { $regex: wRegex } },
                { "createdBy.name": { $regex: wRegex } },
                { "createdBy.email": { $regex: wRegex } },
                { "changedBy.name": { $regex: wRegex } },
                { "changedBy.email": { $regex: wRegex } }
            ]
        }

        const pipeline = [
            { $match: initialMatch },
            // Stage 2: Lean Projection (strip large history arrays)
            {
                $project: {
                    bookingId: 1,
                    name: 1,
                    mobile: 1,
                    rooms: 1,
                    totalAmount: 1,
                    paidAmount: 1,
                    dueAmount: 1,
                    discountAmount: 1,
                    extraService: 1,
                    extraServiceCost: 1,
                    reference: 1,
                    bookedBy: 1,
                    createdBy: 1,
                    changedBy: 1,
                    transactionId: 1,
                    paymentMethod: 1,
                    guestType: 1,
                    requestedByRole: 1,
                    status: 1,
                    createdAt: 1,
                    cancelledAt: 1,
                    cancelReason: 1,
                    refundAmount: 1
                }
            },
            // Stage 3: Compute totalRoomPrice on booking before unwinding
            {
                $addFields: {
                    totalRoomPrice: {
                        $sum: {
                            $map: {
                                input: { $ifNull: ["$rooms", []] },
                                as: "r",
                                in: {
                                    $multiply: [
                                        { $ifNull: ["$$r.nights", 1] },
                                        { $ifNull: ["$$r.pricePerNight", 0] }
                                    ]
                                }
                            }
                        }
                    }
                }
            },
            // Stage 4: Unwind rooms
            { $unwind: "$rooms" }
        ]

        // Stage 5: Date filter on unwound room
        if (startDate || endDate) {
            let dateCondition = {}
            if (startDate && endDate) {
                dateCondition = {
                    $or: [
                        {
                            status: { $in: CANCEL_STATUSES },
                            cancelledAt: { $exists: true, $ne: null },
                            $expr: {
                                $and: [
                                    { $gte: [{ $substrCP: [{ $toString: "$cancelledAt" }, 0, 10] }, startDate] },
                                    { $lte: [{ $substrCP: [{ $toString: "$cancelledAt" }, 0, 10] }, endDate] }
                                ]
                            }
                        },
                        {
                            "rooms.checkIn": { $lte: endDate },
                            "rooms.checkOut": { $gte: startDate }
                        }
                    ]
                }
            } else if (startDate) {
                dateCondition = {
                    $or: [
                        {
                            status: { $in: CANCEL_STATUSES },
                            cancelledAt: { $exists: true, $ne: null },
                            $expr: { $gte: [{ $substrCP: [{ $toString: "$cancelledAt" }, 0, 10] }, startDate] }
                        },
                        { "rooms.checkOut": { $gte: startDate } }
                    ]
                }
            } else if (endDate) {
                dateCondition = {
                    $or: [
                        {
                            status: { $in: CANCEL_STATUSES },
                            cancelledAt: { $exists: true, $ne: null },
                            $expr: { $lte: [{ $substrCP: [{ $toString: "$cancelledAt" }, 0, 10] }, endDate] }
                        },
                        { "rooms.checkIn": { $lte: endDate } }
                    ]
                }
            }
            pipeline.push({ $match: dateCondition })
        }

        // Stage 6: Room calculations & amounts normalization
        pipeline.push(
            {
                $addFields: {
                    categoryName: { $ifNull: ["$rooms.categoryName", "Room"] },
                    roomNo: { $ifNull: ["$rooms.roomNo", ""] },
                    nights: { $ifNull: ["$rooms.nights", 1] },
                    roomBase: {
                        $multiply: [
                            { $ifNull: ["$rooms.nights", 1] },
                            { $ifNull: ["$rooms.pricePerNight", 0] }
                        ]
                    },
                    computedGuestType: {
                        $cond: [
                            { $and: [{ $ne: [{ $ifNull: ["$guestType", ""] }, ""] }, { $ne: ["$guestType", null] }] },
                            "$guestType",
                            {
                                $cond: [
                                    {
                                        $or: [
                                            { $eq: ["$requestedByRole", "user"] },
                                            { $eq: [{ $ifNull: ["$requestedByRole", ""] }, ""] }
                                        ]
                                    },
                                    "WEB",
                                    "Walk-In"
                                ]
                            }
                        ]
                    }
                }
            },
            {
                $addFields: {
                    roomRatio: {
                        $cond: [
                            { $gt: ["$totalRoomPrice", 0] },
                            { $divide: ["$roomBase", "$totalRoomPrice"] },
                            1
                        ]
                    }
                }
            },
            {
                $addFields: {
                    amount: {
                        $cond: [
                            { $in: ["$status", CANCEL_STATUSES] },
                            { $multiply: ["$roomRatio", { $ifNull: ["$paidAmount", 0] }] },
                            {
                                $max: [
                                    0,
                                    {
                                        $add: [
                                            "$roomBase",
                                            {
                                                $multiply: [
                                                    "$roomRatio",
                                                    {
                                                        $subtract: [
                                                            { $ifNull: ["$extraServiceCost", 0] },
                                                            { $ifNull: ["$discountAmount", 0] }
                                                        ]
                                                    }
                                                ]
                                            }
                                        ]
                                    }
                                ]
                            }
                        ]
                    },
                    displayPaidAmount: {
                        $cond: [
                            { $in: ["$status", CANCEL_STATUSES] },
                            { $ifNull: ["$paidAmount", 0] },
                            { $ifNull: ["$paidAmount", 0] }
                        ]
                    },
                    displayDueAmount: {
                        $cond: [
                            { $in: ["$status", CANCEL_STATUSES] },
                            0,
                            { $ifNull: ["$dueAmount", 0] }
                        ]
                    }
                }
            }
        )

        // Stage 7: Post-unwind filters for category, room, guestType, search
        const postMatch = {}
        if (category && category !== "all") {
            postMatch.categoryName = category
        }
        if (room && room !== "all") {
            postMatch.roomNo = String(room).trim()
        }
        if (guestType && guestType !== "all") {
            postMatch.computedGuestType = guestType
        }
        if (search && search.trim()) {
            const s = search.trim()
            const sRegex = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
            postMatch.$or = [
                { name: { $regex: sRegex } },
                { mobile: { $regex: sRegex } },
                { bookingId: { $regex: sRegex } },
                { categoryName: { $regex: sRegex } },
                { roomNo: { $regex: sRegex } },
                { transactionId: { $regex: sRegex } },
                { reference: { $regex: sRegex } },
                { paymentMethod: { $regex: sRegex } }
            ]
        }
        if (Object.keys(postMatch).length > 0) {
            pipeline.push({ $match: postMatch })
        }

        // Table row projection
        const rowProjection = {
            _id: 1,
            bookingId: 1,
            guestName: "$name",
            guestPhone: "$mobile",
            categoryName: 1,
            roomNo: 1,
            checkIn: "$rooms.checkIn",
            checkOut: "$rooms.checkOut",
            nights: 1,
            adults: { $ifNull: ["$rooms.adults", 1] },
            children: { $ifNull: ["$rooms.children", { $ifNull: ["$rooms.babies", 0] }] },
            amount: 1,
            reference: { $ifNull: ["$reference", ""] },
            transactionId: { $ifNull: ["$transactionId", ""] },
            paymentMethod: { $ifNull: ["$paymentMethod", ""] },
            paidAmount: "$displayPaidAmount",
            dueAmount: "$displayDueAmount",
            extraService: { $ifNull: ["$extraService", ""] },
            extraServiceCost: { $ifNull: ["$extraServiceCost", 0] },
            requestedByRole: { $ifNull: ["$requestedByRole", ""] },
            guestType: "$computedGuestType",
            bookedBy: { $ifNull: ["$bookedBy", { $ifNull: ["$createdBy", "$changedBy"] }] },
            status: 1,
            createdAt: 1,
            cancelReason: { $ifNull: ["$cancelReason", ""] },
            refundAmount: { $ifNull: ["$refundAmount", 0] }
        }

        const paginatedStages = [
            { $sort: { _id: -1 } }
        ]

        if (!isExport) {
            paginatedStages.push({ $skip: skip })
            paginatedStages.push({ $limit: limit })
        }
        paginatedStages.push({ $project: rowProjection })

        // Stage 8: Facet
        pipeline.push({
            $facet: {
                paginatedResults: paginatedStages,
                roomItemSummary: [
                    {
                        $group: {
                            _id: null,
                            totalDataCount: { $sum: 1 },
                            totalRevenue: { $sum: "$amount" },
                            totalNights: { $sum: "$nights" }
                        }
                    }
                ],
                distinctBookingSummary: [
                    {
                        $group: {
                            _id: "$_id",
                            paidAmount: { $first: "$displayPaidAmount" },
                            dueAmount: { $first: "$displayDueAmount" }
                        }
                    },
                    {
                        $group: {
                            _id: null,
                            distinctBookingsCount: { $sum: 1 },
                            totalPaid: { $sum: "$paidAmount" },
                            totalDue: { $sum: "$dueAmount" }
                        }
                    }
                ],
                roomBreakdown: [
                    {
                        $group: {
                            _id: "$categoryName",
                            totalRevenue: { $sum: "$amount" },
                            bookingCount: { $sum: 1 },
                            totalNights: { $sum: "$nights" }
                        }
                    },
                    { $sort: { totalRevenue: -1 } },
                    {
                        $project: {
                            _id: 0,
                            roomName: "$_id",
                            totalRevenue: 1,
                            bookingCount: 1,
                            totalNights: 1
                        }
                    }
                ]
            }
        })

        const aggregationResult = (await bookingCollection.aggregate(pipeline).toArray())[0] || {}

        const paginatedResult = aggregationResult.paginatedResults || []
        const itemSummary = aggregationResult.roomItemSummary?.[0] || {}
        const bookingSummary = aggregationResult.distinctBookingSummary?.[0] || {}
        const roomBreakdown = aggregationResult.roomBreakdown || []

        const totalDataCount = Number(itemSummary.totalDataCount || 0)
        const totalRevenue = Math.round(Number(itemSummary.totalRevenue || 0))
        const totalPaid = Math.round(Number(bookingSummary.totalPaid || 0))
        const totalDue = Math.round(Number(bookingSummary.totalDue || 0))
        const totalNights = Number(itemSummary.totalNights || 0)
        const distinctBookingsCount = Number(bookingSummary.distinctBookingsCount || 0)

        res.send({
            result: paginatedResult,
            totalDataCount,
            totalRevenue,
            totalConfirmedBookings: distinctBookingsCount,
            summary: {
                totalRevenue,
                totalPaid,
                totalDue,
                totalNights,
                distinctBookingsCount
            },
            roomBreakdown,
            limit: isExport ? totalDataCount : limit,
            skip: isExport ? 0 : skip,
            filter: {
                startDate: startDate || null,
                endDate: endDate || null,
                search: search || null
            }
        })
    } catch (err) {
        console.error("Income breakdown error:", err)
        res.status(500).send({ message: "Failed to load income breakdown" })
    }
})

// Staff / Agent / Manager Role Sells Overview & Detailed Breakdown
app.get("/sales/my-overview", verifyFBToken, async (req, res) => {
    try {
        const { email, name, role } = req.query
        const now = new Date()
        const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1)
        const currentMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)

        const allBookings = await bookingCollection.find().sort({ _id: -1 }).toArray()
        const hydratedBookings = await hydrateBookingsWithRooms(allBookings, roomCollection, categoryAndRoomCollection)

        const cleanEmail = String(email || req.decodedEmail || "").trim().toLowerCase()
        const cleanName = String(name || "").trim().toLowerCase()

        const isUserOrRoleMatched = (booking) => {
            if (!cleanEmail && !cleanName) return true
            const ref = String(booking.reference || "").trim().toLowerCase()
            const bEmail = String(booking.bookedBy?.email || booking.createdBy?.email || booking.userEmail || "").trim().toLowerCase()
            const bName = String(booking.bookedBy?.name || booking.createdBy?.name || "").trim().toLowerCase()

            if (cleanEmail && (ref === cleanEmail || bEmail === cleanEmail || ref.includes(cleanEmail))) return true
            if (cleanName && (ref === cleanName || bName === cleanName || ref.includes(cleanName))) return true
            return false
        }

        const myBookings = hydratedBookings.filter(isUserOrRoleMatched)
        const confirmedMyBookings = myBookings.filter(isRevenueBooking)

        const totalSales = confirmedMyBookings.reduce((sum, b) => sum + getBookingRevenue(b), 0)
        const totalPaid = confirmedMyBookings.reduce((sum, b) => sum + Number(b.paidAmount || 0), 0)
        const totalDue = Math.max(0, totalSales - totalPaid)

        const monthlyBookings = confirmedMyBookings.filter(b => {
            const bDate = b.cancelledAt ? new Date(b.cancelledAt) : (b.createdAt ? new Date(b.createdAt) : null)
            if (bDate && bDate >= currentMonthStart && bDate <= currentMonthEnd) return true
            const firstRoom = getBookingRooms(b)[0]
            if (firstRoom?.checkIn) {
                const cIn = new Date(firstRoom.checkIn)
                if (cIn >= currentMonthStart && cIn <= currentMonthEnd) return true
            }
            return false
        })
        const monthlySales = monthlyBookings.reduce((sum, b) => sum + getBookingRevenue(b), 0)

        // Category & Room Breakdown for this user/agent
        const categoryBreakdownMap = {}
        const detailedSellsList = []

        confirmedMyBookings.forEach(booking => {
            const isCancelled = CANCEL_STATUSES.includes(booking.status)
            const rooms = getBookingRooms(booking)
            const retainedPaid = Number(booking.paidAmount || 0)
            const totalRoomPrice = rooms.reduce((sum, r) => sum + (getRoomTotal(r) || 1), 0) || 1

            rooms.forEach(room => {
                const catLabel = room.categoryName || room.room?.name || room.room?.category || "Standard Room"
                const extraCost = Number(booking.extraServiceCost || 0)
                const discount = Number(booking.discountAmount || 0)
                const roomRatio = (getRoomTotal(room) || 1) / totalRoomPrice
                const rTotal = isCancelled
                    ? (roomRatio * retainedPaid)
                    : Math.max(0, getRoomTotal(room) + (roomRatio * (extraCost - discount)))
                const nights = getNightCount(room.checkIn, room.checkOut)

                categoryBreakdownMap[catLabel] = (categoryBreakdownMap[catLabel] || 0) + rTotal

                const bTotal = getBookingRevenue(booking)
                const bPaid = isCancelled ? retainedPaid : getBookingPaidAmount(booking)
                const bDue = isCancelled ? 0 : getBookingDueAmount(booking)
                const bDiscount = isCancelled ? 0 : getBookingDiscount(booking)

                detailedSellsList.push({
                    _id: booking._id,
                    bookingId: booking.bookingId,
                    guestName: booking.name,
                    guestPhone: booking.mobile,
                    categoryName: catLabel,
                    roomNo: room.roomNo || "Assigned Room",
                    checkIn: room.checkIn,
                    checkOut: room.checkOut,
                    nights,
                    roomPrice: room.pricePerNight,
                    totalAmount: rTotal,
                    bookingTotal: bTotal,
                    discountAmount: bDiscount,
                    paidAmount: bPaid,
                    dueAmount: bDue,
                    paymentMethod: booking.paymentMethod || booking.paymentHistory?.[0]?.paymentMethod || "Direct",
                    status: booking.status,
                    createdAt: booking.createdAt,
                    reference: booking.reference || "Direct"
                })
            })
        })

        res.send({
            totalSales,
            monthlySales,
            totalPaid,
            totalDue,
            totalBookingsCount: confirmedMyBookings.length,
            monthlyBookingsCount: monthlyBookings.length,
            currentMonthName: now.toLocaleString('default', { month: 'long', year: 'numeric' }),
            categoryBreakdown: Object.entries(categoryBreakdownMap).map(([category, amount]) => ({ category, amount })),
            detailedSells: detailedSellsList.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
        })
    } catch (err) {
        console.error("Sales overview error:", err)
        res.status(500).send({ message: "Failed to load sales overview" })
    }
})

// Schedule Price Change for Category
app.post("/categoryandroom/:id/schedule-price", verifyFBToken, verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params
        const { effectiveDate, price, note } = req.body
        if (!effectiveDate || isNaN(Number(price))) {
            return res.status(400).send({ message: "Effective date and valid price are required." })
        }

        const catId = toObjectId(id) || id
        const query = { _id: catId }
        const category = await categoryAndRoomCollection.findOne(query)
        if (!category) {
            return res.status(404).send({ message: "Category not found." })
        }

        const todayStr = getTodayDateStr()
        const targetPrice = Number(price)

        // If scheduled date has already arrived or is today, apply immediately
        if (effectiveDate <= todayStr) {
            const currentPrice = Number(category.price || 0)
            const historyEntry = {
                id: Math.random().toString(36).slice(2, 9),
                previousPrice: currentPrice,
                newPrice: targetPrice,
                effectiveDate,
                note: note ? String(note).trim() : "",
                appliedAt: new Date()
            }

            // Remove any existing entry for this exact effectiveDate first
            await categoryAndRoomCollection.updateOne(query, {
                $pull: { scheduledPrices: { effectiveDate } }
            })

            const result = await categoryAndRoomCollection.updateOne(query, {
                $set: {
                    price: targetPrice,
                    updatedAt: new Date()
                },
                $push: {
                    priceHistory: historyEntry
                }
            })

            return res.send({
                success: true,
                appliedImmediately: true,
                entry: historyEntry,
                message: `Price updated to ৳${targetPrice.toLocaleString()} and previous price saved to history.`,
                result
            })
        }

        // Future scheduled price: keep in Active Price Schedules
        const scheduleEntry = {
            id: Math.random().toString(36).slice(2, 9),
            effectiveDate,
            price: targetPrice,
            note: note ? String(note).trim() : "",
            createdAt: new Date()
        }

        // Remove any existing entry for this exact effectiveDate first, then push
        await categoryAndRoomCollection.updateOne(query, {
            $pull: { scheduledPrices: { effectiveDate } }
        })

        const result = await categoryAndRoomCollection.updateOne(query, {
            $push: { scheduledPrices: scheduleEntry },
            $set: { updatedAt: new Date() }
        })

        res.send({
            success: true,
            appliedImmediately: false,
            entry: scheduleEntry,
            message: `Price of ৳${targetPrice.toLocaleString()} scheduled for ${effectiveDate}.`,
            result
        })
    } catch (err) {
        console.error("Schedule price error:", err)
        res.status(500).send({ message: "Failed to schedule price change." })
    }
})

// Delete / Cancel Scheduled Price (only removes from scheduledPrices, never history)
app.delete("/categoryandroom/:id/schedule-price/:effectiveDate", verifyFBToken, verifyAdmin, async (req, res) => {
    try {
        const { id, effectiveDate } = req.params
        const catId = toObjectId(id) || id
        const query = { _id: catId }
        const result = await categoryAndRoomCollection.updateOne(query, {
            $pull: { scheduledPrices: { effectiveDate } },
            $set: { updatedAt: new Date() }
        })
        res.send(result)
    } catch (err) {
        console.error("Delete schedule price error:", err)
        res.status(500).send({ message: "Failed to delete scheduled price." })
    }
})

app.get("/health", async (req, res) => {
    const result = {
        status: "ok"
    }
    res.send(result)
})

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
    app.listen(port, () => {
        console.log(`Server is running on port:${port}`)
    })
}

module.exports = app
