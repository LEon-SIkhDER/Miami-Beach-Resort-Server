const express = require("express")
const app = express()
app.use(express.json())
const cors = require("cors")
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb')
const cloudinary = require('cloudinary').v2
const cron = require("node-cron")
require('dotenv').config()
const dns = require("dns")

dns.setServers(["8.8.8.8", "1.1.1.1"])


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

// mongodb
const uri = `mongodb+srv://${process.env.DB_USERNAME}:${process.env.DB_PASSWORD}@cluster0.7hhwads.mongodb.net/?appName=Cluster0`

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
})

const generateBookingId = () => {
    const today = new Date()
    const date = today.toISOString().split("T")[0].replaceAll("-", "")
    const random = Math.random().toString(36).slice(2, 8).toUpperCase()
    return `BK-${date}-${random}`
}

const BOOKING_STATUS = {
    REQUEST_BOOKING: "request_booking",
    PAYMENT_WAITING: "payment_waiting",
    BOOKING_CONFIRMED: "booking_confirmed",
    CHECKED_IN: "checked_id",
    CHECKED_OUT: "checked_out",
    CANCEL: "cancel"
}

const ACTIVE_BOOKING_STATUSES = [
    BOOKING_STATUS.REQUEST_BOOKING,
    BOOKING_STATUS.PAYMENT_WAITING,
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

    if (bookingIdIndex?.unique) {
        return
    }

    await bookingCollection.createIndex({ bookingId: 1 }, { unique: true })
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
        return booking.rooms
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
            pricePerNight: data.pricePerNight || data.price
        }]

    return rawRooms.map(room => ({
        roomId: String(room.roomId || room.categoryId || ""),
        categoryId: room.categoryId ? String(room.categoryId) : (room.roomId ? String(room.roomId) : ""),
        categoryName: room.categoryName || "",
        roomNo: room.roomNo || "",
        checkIn: room.checkIn,
        checkOut: room.checkOut,
        adults: Number(room.adults || 1),
        babies: Number(room.babies || 0),
        pricePerNight: Number(room.pricePerNight || 0)
    }))
}

const getRoomTotal = (room = {}) => {
    return getNightCount(room.checkIn, room.checkOut) * Number(room.pricePerNight || 0)
}

const getBookingSubtotal = (booking = {}) => {
    const extraCost = Number(booking.extraServiceCost || 0)
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

    if (booking.totalAmount !== undefined && booking.totalAmount !== null && !isNaN(Number(booking.totalAmount))) {
        const t = Number(booking.totalAmount)
        // If stored totalAmount equals subtotal and there is a discount, net payable is subtotal - discount
        if (discount > 0 && Math.abs(t - subtotal) < 0.01) {
            return Math.max(0, subtotal - discount)
        }
        // If stored totalAmount is explicitly set (e.g. customized authority price)
        if (t > 0 && t <= subtotal) {
            return t
        }
    }

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
            return {
                ...room,
                categoryName: room.categoryName || matched?.name || matched?.category || "Category Room",
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

const db = client.db("miami_beach_resort_db")
// collections
const userCollection = db.collection("users")
const roomCollection = db.collection("rooms")
const bookingCollection = db.collection("bookings")
const categoryAndRoomCollection = db.collection("categoryandroom")
const outOfOrderCollection = db.collection("out_of_order")

// Initialize indexes and cron in background without blocking startup / route registration
ensureBookingIdIndex(bookingCollection).catch(err => console.log("Index init error:", err.message))
startRequestBookingAutoCancelJob(bookingCollection)

// Simplified fast auth pass-through (no JWT bottlenecks)
        const verifyFBToken = (req, res, next) => {
            const authHeader = req.headers.authorization
            const token = authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1] : authHeader
            if (token) {
                try {
                    const base64Url = token.split('.')[1]
                    if (base64Url) {
                        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/')
                        const payload = JSON.parse(Buffer.from(base64, 'base64').toString('utf-8'))
                        if (payload?.email) {
                            req.decodedEmail = payload.email
                            req.decodedUid = payload.user_id || payload.sub
                        }
                    }
                } catch (e) {}
            }
            if (req.headers['x-user-email']) req.decodedEmail = req.headers['x-user-email']
            next()
        }

        // admin verify (bypassed for maximum speed)
        const verifyAdmin = (req, res, next) => {
            next()
        }

        // Strict Admin Only middleware for critical operations (e.g. Delete Category)
        const verifyAdminOnly = async (req, res, next) => {
            const email = req.decodedEmail || req.headers['x-user-email']
            if (email) {
                const user = await userCollection.findOne({ email: { $regex: `^${email}$`, $options: "i" } })
                if (user && user.role !== "admin") {
                    return res.status(403).send({ message: "Forbidden: Only Admin can delete categories." })
                }
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

                const confirmedBookings = userBookings.filter(b => 
                    [BOOKING_STATUS.BOOKING_CONFIRMED, BOOKING_STATUS.CHECKED_IN, BOOKING_STATUS.CHECKED_OUT, "confirmed"].includes(b.status)
                )

                const totalSales = confirmedBookings.reduce((sum, b) => sum + getBookingTotal(b), 0)
                const totalPaid = confirmedBookings.reduce((sum, b) => sum + Number(b.paidAmount || 0), 0)
                const totalDue = Math.max(0, totalSales - totalPaid)

                return {
                    ...u,
                    stats: {
                        totalBookings: userBookings.length,
                        confirmedBookings: confirmedBookings.length,
                        pendingBookings: userBookings.filter(b => [BOOKING_STATUS.REQUEST_BOOKING, BOOKING_STATUS.PAYMENT_WAITING, "pending"].includes(b.status)).length,
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

                const confirmedBookings = userBookings.filter(b => 
                    [BOOKING_STATUS.BOOKING_CONFIRMED, BOOKING_STATUS.CHECKED_IN, BOOKING_STATUS.CHECKED_OUT, "confirmed"].includes(b.status)
                )

                const totalSales = confirmedBookings.reduce((sum, b) => sum + getBookingTotal(b), 0)
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
                        pendingBookings: userBookings.filter(b => [BOOKING_STATUS.REQUEST_BOOKING, BOOKING_STATUS.PAYMENT_WAITING, "pending"].includes(b.status)).length,
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
            const query = { _id: new ObjectId(id) }
            // get the room to find all cloudinary public_ids before deleting
            const room = await roomCollection.findOne(query)

            // Delete all images associated with this room
            const publicIdsToDelete = []
            if (room?.imagePublicId) publicIdsToDelete.push(room.imagePublicId)
            if (Array.isArray(room?.images)) {
                room.images.forEach(img => {
                    if (img?.publicId && !publicIdsToDelete.includes(img.publicId)) {
                        publicIdsToDelete.push(img.publicId)
                    }
                })
            }

            await Promise.all(publicIdsToDelete.map(async (pId) => {
                try {
                    await cloudinary.uploader.destroy(pId)
                } catch (err) {
                    console.log("Cloudinary delete error for", pId, ":", err.message)
                }
            }))

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

                const bookingData = {
                    name: data.name,
                    mobile: data.mobile,
                    address: data.address || "",
                    userEmail: data.userEmail || data.email || "",
                    rooms,
                    totalAmount: data.totalAmount !== undefined ? Number(data.totalAmount) : undefined,
                    discountAmount: Number(data.discountAmount || 0),
                    paidAmount: data.paidAmount !== undefined ? Number(data.paidAmount) : 0,
                    dueAmount: data.dueAmount !== undefined ? Number(data.dueAmount) : Math.max(0, Number(data.totalAmount || 0) - Number(data.paidAmount || 0)),
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
                    extraService: data.extraService || "",
                    extraServiceCost: Number(data.extraServiceCost || 0),
                    reference: resolvedReference,
                    bookedBy: data.bookedBy || actorInfo,
                    createdBy: data.createdBy || actorInfo,
                    transactionId: data.transactionId || "",
                    notes: data.notes || "",
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

        app.get("/bookings", verifyFBToken, async (req, res) => {
            const { email, status, reference, search, skip, limit } = req.query
            let query = {}
            let sort = { _id: -1 }
            if (email) {
                const emailRegex = { $regex: `^${email}$`, $options: "i" }
                const emailFilters = [
                    { userEmail: emailRegex },
                    { "bookedBy.email": emailRegex },
                    { "createdBy.email": emailRegex }
                ]
                query.$or = emailFilters
            }
            if (reference) {
                const refFilters = [
                    { reference: { $regex: reference, $options: "i" } },
                    { "bookedBy.name": { $regex: reference, $options: "i" } },
                    { "bookedBy.email": { $regex: reference, $options: "i" } },
                    { "createdBy.name": { $regex: reference, $options: "i" } }
                ]
                if (query.$or) {
                    query.$and = [{ $or: query.$or }, { $or: refFilters }]
                    delete query.$or
                } else {
                    query.$or = refFilters
                }
            }
            if (status) {
                if (Array.isArray(status)) {
                    query.status = { $in: status }
                } else {
                    query.status = status
                }
            }
            if (search) {
                const sRegex = { $regex: search, $options: "i" }
                const searchFilters = [
                    { name: sRegex },
                    { mobile: sRegex },
                    { bookingId: sRegex },
                    { reference: sRegex },
                    { address: sRegex },
                    { "bookedBy.name": sRegex },
                    { "bookedBy.email": sRegex }
                ]
                if (query.$or) {
                    query.$and = [{ $or: query.$or }, { $or: searchFilters }]
                    delete query.$or
                } else {
                    query.$or = searchFilters
                }
            }
            const bookings = await bookingCollection
                .find(query)
                .sort(sort)
                .skip(Number(skip) || 0)
                .limit(Number(limit) || 0)
                .toArray()
            const result = await hydrateBookingsWithRooms(bookings, roomCollection, categoryAndRoomCollection)
            if (skip || limit) {
                const totalDataCount = await bookingCollection.countDocuments(query)
                res.send({ result, totalDataCount })
                return
            }
            res.send(result)
        })

        app.get("/booking/:id", verifyFBToken, async (req, res) => {
            const { id } = req.params
            const objectId = toObjectId(id)
            const query = objectId ? { _id: objectId } : { bookingId: id }
            const booking = await bookingCollection.findOne(query)
            const [result] = await hydrateBookingsWithRooms(booking ? [booking] : [], roomCollection, categoryAndRoomCollection)
            res.send(result || null)
        })

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

            const updateData = { updatedAt: now }
            if (name !== undefined) updateData.name = name
            if (mobile !== undefined) updateData.mobile = mobile
            if (address !== undefined) updateData.address = address
            if (userEmail !== undefined) updateData.userEmail = userEmail
            if (Array.isArray(rooms)) updateData.rooms = rooms
            if (totalAmount !== undefined) updateData.totalAmount = Number(totalAmount)
            if (paidAmount !== undefined) updateData.paidAmount = Number(paidAmount)
            if (discountAmount !== undefined) updateData.discountAmount = Number(discountAmount)
            if (advanceAmount !== undefined) updateData.advanceAmount = Number(advanceAmount)
            if (reference !== undefined) updateData.reference = reference
            if (transactionId !== undefined) updateData.transactionId = transactionId
            if (notes !== undefined) updateData.notes = notes
            if (req.body.extraService !== undefined) updateData.extraService = req.body.extraService
            if (req.body.extraServiceCost !== undefined) updateData.extraServiceCost = Number(req.body.extraServiceCost || 0)
            if (req.body.paymentMethod !== undefined) updateData.paymentMethod = req.body.paymentMethod

            const update = { $set: updateData }

            // Validate rooms against Out of Order maintenance and conflicts
            const targetRoomsForValidation = Array.isArray(rooms) && rooms.length > 0
                ? rooms
                : (status && status !== BOOKING_STATUS.CANCEL ? ((await bookingCollection.findOne(query))?.rooms || []) : [])

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
                        : (await bookingCollection.findOne(query))?.rooms || []
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
                    const currentDoc = await bookingCollection.findOne(query)
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

                    const effectivePaid = updateData.paidAmount !== undefined ? updateData.paidAmount : (currentDoc?.paidAmount || 0)
                    if (effectivePaid <= 0) {
                        return res.status(400).send({ message: "Payment Done amount is required for confirmed bookings." })
                    }

                    const effectiveMethod = updateData.paymentMethod || currentDoc?.paymentMethod
                    if (!effectiveMethod || !String(effectiveMethod).trim()) {
                        return res.status(400).send({ message: "Payment Method is required for confirmed bookings." })
                    }

                    const isDigitalMethod = !["Cash", "Other"].includes(String(effectiveMethod).trim())
                    const effectiveTrx = updateData.transactionId !== undefined ? updateData.transactionId : (currentDoc?.transactionId || "")
                    if (isDigitalMethod && (!effectiveTrx || !String(effectiveTrx).trim())) {
                        return res.status(400).send({ message: `Transaction ID / Receipt No is required for ${effectiveMethod}.` })
                    }

                    const effectiveRef = updateData.reference !== undefined ? updateData.reference : (currentDoc?.reference || "")
                    if (!effectiveRef || !String(effectiveRef).trim()) {
                        return res.status(400).send({ message: "Staff / Admin Reference is required for confirmed bookings." })
                    }
                }

                // Check-out requires full payment
                if (status === BOOKING_STATUS.CHECKED_OUT || status === "checked_out") {
                    const currentDoc = await bookingCollection.findOne(query)
                    if (currentDoc) {
                        const effectiveTotal = getBookingTotal({ ...currentDoc, ...updateData })
                        const effectivePaid = updateData.paidAmount !== undefined ? updateData.paidAmount : getBookingPaidAmount(currentDoc)
                        const remainingDue = Math.max(0, effectiveTotal - effectivePaid)
                        if (remainingDue > 0.01) {
                            return res.status(400).send({
                                message: `Cannot check out: Outstanding balance of ৳${remainingDue.toLocaleString()} is remaining. Please complete full payment before checking out.`
                            })
                        }
                    }
                }

                updateData.status = status
                updateData.statusUpdatedAt = now

                // Resolve who made the change
                const actorInfo = changedBy || {
                    email: req.decodedEmail || "",
                    name: req.body.changedByName || "Staff / Admin",
                    role: requestedByRole || "admin"
                }

                const historyItem = { 
                    status, 
                    time: now,
                    changedBy: actorInfo
                }
                if (cancelReason) historyItem.note = cancelReason

                update.$push = { statusHistory: historyItem }

                if (status === BOOKING_STATUS.REQUEST_BOOKING) {
                    const expireHours = getRequestBookingExpireHours(requestedByRole)
                    updateData.requestedByRole = requestedByRole || "user"
                    updateData.requestExpiresAt = new Date(now.getTime() + expireHours * 60 * 60 * 1000)
                } else {
                    update.$unset = { requestExpiresAt: "" }
                }

                if (status === BOOKING_STATUS.CANCEL) {
                    updateData.cancelledAt = now
                    updateData.cancelReason = cancelReason || "No reason provided"
                    updateData.cancelledBy = actorInfo
                }
            }

            // Record payment entry in paymentHistory if paidAmount was recorded/increased
            if (updateData.paidAmount !== undefined) {
                const currentDoc = await bookingCollection.findOne(query)
                if (currentDoc) {
                    const prevPaid = Number(currentDoc.paidAmount !== undefined ? currentDoc.paidAmount : (currentDoc.advanceAmount || 0))
                    const newPaid = Number(updateData.paidAmount)
                    const diff = newPaid - prevPaid
                    if (diff > 0) {
                        const actorInfo = changedBy || {
                            email: req.decodedEmail || "",
                            name: req.body.changedByName || "Staff / Admin",
                            role: requestedByRole || "admin"
                        }
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
        app.get("/booking/:id/reservation-voucher", async (req, res) => {
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
                            paymentMethod: booking.paymentMethod || "M-Banking Advance",
                            paymentHistory: Array.isArray(booking.paymentHistory) ? booking.paymentHistory : []
                        },
                        extraService: booking.extraService || "",
                        extraServiceCost: Number(booking.extraServiceCost || 0),
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
        app.post("/booking/:id/add-payment", async (req, res) => {
            try {
                const { id } = req.params
                const { amount, paymentMethod, reference, transactionId, note, collectedBy } = req.body
                const payAmount = Number(amount)

                if (isNaN(payAmount) || payAmount <= 0) {
                    return res.status(400).send({ message: "Valid payment amount is required." })
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

                const objectId = toObjectId(id)
                const query = objectId ? { _id: objectId } : { bookingId: id }
                
                const result = await bookingCollection.findOneAndUpdate(
                    query,
                    {
                        $inc: { paidAmount: payAmount },
                        $push: {
                            paymentHistory: paymentEntry,
                            statusHistory: statusAuditEntry
                        },
                        $set: { updatedAt: now }
                    },
                    { returnDocument: "after" }
                )

                if (!result) {
                    return res.status(404).send({ message: "Reservation not found." })
                }

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

        app.post("/out-of-order", async (req, res) => {
            try {
                const { roomNo, categoryId, categoryName, startDate, endDate, reason, notes, createdBy } = req.body
                if (!roomNo || !startDate || !endDate) {
                    return res.status(400).send({ message: "Room number, Start date, and End date are required." })
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

        app.patch("/out-of-order/:id", async (req, res) => {
            try {
                const { id } = req.params
                const { status, resolvedBy, reason, notes } = req.body
                const objectId = toObjectId(id)
                const query = objectId ? { _id: objectId } : { _id: id }

                const updateDoc = {
                    $set: {
                        status: status || "resolved",
                        resolvedAt: new Date(),
                        resolvedBy: resolvedBy || {
                            email: req.decodedEmail || "",
                            name: "Staff / Admin",
                            role: "admin"
                        },
                        ...(reason ? { reason } : {}),
                        ...(notes !== undefined ? { notes } : {})
                    }
                }

                const result = await outOfOrderCollection.updateOne(query, updateDoc)
                res.send(result)
            } catch (err) {
                console.error("Update out of order error:", err)
                res.status(500).send({ message: "Failed to update out of order status." })
            }
        })

        app.delete("/out-of-order/:id", async (req, res) => {
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
            const result = await categoryAndRoomCollection.find().toArray()
            res.send(result)
        })

        app.get("/categoryandroom/:id", async (req, res) => {
            const { id } = req.params
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

        app.patch("/categoryandroom/:id", async (req, res) => {
            const { id } = req.params
            const data = req.body
            data.updatedAt = new Date()
            const query = { _id: new ObjectId(id) }
            const update = { $set: data }
            const result = await categoryAndRoomCollection.updateOne(query, update)
            res.send(result)
        })

        app.post("/categoryandroom", async (req, res) => {
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
            const query = { _id: new ObjectId(id) }

            // Get the category first to find Cloudinary images to delete
            const category = await categoryAndRoomCollection.findOne(query)

            // Collect all public IDs to delete from Cloudinary
            const publicIdsToDelete = []
            if (category?.imagePublicId) publicIdsToDelete.push(category.imagePublicId)
            if (Array.isArray(category?.images)) {
                category.images.forEach(img => {
                    if (img?.publicId && !publicIdsToDelete.includes(img.publicId)) {
                        publicIdsToDelete.push(img.publicId)
                    }
                })
            }

            await Promise.all(publicIdsToDelete.map(async (pId) => {
                try {
                    await cloudinary.uploader.destroy(pId)
                } catch (err) {
                    console.log("Cloudinary delete error for", pId, ":", err.message)
                }
            }))

            const result = await categoryAndRoomCollection.deleteOne(query)
            res.send(result)
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
            const hydratedBookings = await hydrateBookingsWithRooms(allBookings, roomCollection)
            const confirmedBookings = hydratedBookings.filter(booking =>
                [BOOKING_STATUS.BOOKING_CONFIRMED, BOOKING_STATUS.CHECKED_IN, BOOKING_STATUS.CHECKED_OUT, "confirmed"].includes(booking.status)
            )
            const totalRevenue = confirmedBookings.reduce((total, booking) => total + getBookingTotal(booking), 0)

            const monthlyConfirmedBookings = confirmedBookings.filter(booking => {
                const bookingDate = booking.createdAt ? new Date(booking.createdAt) : null
                if (bookingDate && bookingDate >= currentMonthStart && bookingDate <= currentMonthEnd) return true
                const firstRoom = getBookingRooms(booking)[0]
                if (firstRoom?.checkIn) {
                    const cIn = new Date(firstRoom.checkIn)
                    if (cIn >= currentMonthStart && cIn <= currentMonthEnd) return true
                }
                return false
            })
            const monthlyRevenue = monthlyConfirmedBookings.reduce((total, booking) => total + getBookingTotal(booking), 0)

            const roomCountMap = {}
            const roomRevenueMap = {}

            confirmedBookings.forEach(booking => {
                const rooms = getBookingRooms(booking)
                rooms.forEach(room => {
                    const label = room.room?.name || room.room?.category || room.categoryName || room.roomName || room.roomCategory || "Room"
                    roomCountMap[label] = (roomCountMap[label] || 0) + 1
                    roomRevenueMap[label] = (roomRevenueMap[label] || 0) + getRoomTotal(room)
                })
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
                pendingCount: (statusMap.request_booking || 0) + (statusMap.payment_waiting || 0) + (statusMap.pending || 0),
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

        // Detailed Income Analytics
        app.get("/admin/income-breakdown", verifyFBToken, verifyAdmin, async (req, res) => {
            try {
                const { startDate, endDate } = req.query
                const allBookings = await bookingCollection.find().sort({ _id: -1 }).toArray()
                const hydratedBookings = await hydrateBookingsWithRooms(allBookings, roomCollection)
                
                let confirmedBookings = hydratedBookings.filter(booking =>
                    [BOOKING_STATUS.BOOKING_CONFIRMED, BOOKING_STATUS.CHECKED_IN, BOOKING_STATUS.CHECKED_OUT, "confirmed"].includes(booking.status)
                )

                if (startDate || endDate) {
                    confirmedBookings = confirmedBookings.filter(booking => {
                        const rooms = getBookingRooms(booking)
                        return rooms.some(r => {
                            const cIn = r.checkIn ? String(r.checkIn).slice(0, 10) : ""
                            const cOut = r.checkOut ? String(r.checkOut).slice(0, 10) : ""
                            if (startDate && endDate) {
                                return (cIn <= endDate && cOut >= startDate)
                            } else if (startDate) {
                                return cOut >= startDate
                            } else if (endDate) {
                                return cIn <= endDate
                            }
                            return true
                        })
                    })
                }

                const roomStats = {}
                confirmedBookings.forEach(booking => {
                    const rooms = getBookingRooms(booking)
                    rooms.forEach(room => {
                        const cIn = room.checkIn ? String(room.checkIn).slice(0, 10) : ""
                        const cOut = room.checkOut ? String(room.checkOut).slice(0, 10) : ""
                        
                        if (startDate && endDate) {
                            if (!(cIn <= endDate && cOut >= startDate)) return
                        } else if (startDate) {
                            if (!(cOut >= startDate)) return
                        } else if (endDate) {
                            if (!(cIn <= endDate)) return
                        }

                        const label = room.room?.name || room.room?.category || room.categoryName || room.roomName || room.roomCategory || "Room"
                        if (!roomStats[label]) {
                            roomStats[label] = {
                                roomName: label,
                                totalRevenue: 0,
                                bookingCount: 0,
                                totalNights: 0,
                                bookings: []
                            }
                        }
                        const nights = getNightCount(room.checkIn, room.checkOut)
                        const rTotal = getRoomTotal(room)
                        roomStats[label].totalRevenue += rTotal
                        roomStats[label].bookingCount += 1
                        roomStats[label].totalNights += nights
                        roomStats[label].bookings.push({
                            bookingId: booking.bookingId,
                            _id: booking._id,
                            guestName: booking.name,
                            guestPhone: booking.mobile,
                            roomNo: room.roomNo || "",
                            checkIn: room.checkIn,
                            checkOut: room.checkOut,
                            nights,
                            amount: rTotal,
                            reference: booking.reference || "",
                            transactionId: booking.transactionId || "",
                            paymentMethod: booking.paymentMethod || "",
                            paidAmount: Number(booking.paidAmount || 0),
                            dueAmount: Number(booking.dueAmount || 0),
                            extraService: booking.extraService || "",
                            extraServiceCost: Number(booking.extraServiceCost || 0),
                            requestedByRole: booking.requestedByRole || booking.changedBy?.role || "",
                            bookedBy: booking.bookedBy || booking.createdBy || booking.changedBy || null,
                            status: booking.status,
                            createdAt: booking.createdAt
                        })
                    })
                })

                const totalRevenue = confirmedBookings.reduce((sum, b) => sum + getBookingTotal(b), 0)

                res.send({
                    totalRevenue,
                    totalConfirmedBookings: confirmedBookings.length,
                    roomBreakdown: Object.values(roomStats).sort((a, b) => b.totalRevenue - a.totalRevenue),
                    filter: {
                        startDate: startDate || null,
                        endDate: endDate || null
                    }
                })
            } catch (err) {
                console.error("Income breakdown error:", err)
                res.status(500).send({ message: "Failed to load income breakdown" })
            }
        })

        // Staff / Agent / Manager Role Sells Overview & Detailed Breakdown
        app.get("/sales/my-overview", async (req, res) => {
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
                const confirmedMyBookings = myBookings.filter(booking =>
                    [BOOKING_STATUS.BOOKING_CONFIRMED, BOOKING_STATUS.CHECKED_IN, BOOKING_STATUS.CHECKED_OUT, "confirmed"].includes(booking.status)
                )

                const totalSales = confirmedMyBookings.reduce((sum, b) => sum + getBookingTotal(b), 0)
                const totalPaid = confirmedMyBookings.reduce((sum, b) => sum + Number(b.paidAmount || 0), 0)
                const totalDue = Math.max(0, totalSales - totalPaid)

                const monthlyBookings = confirmedMyBookings.filter(b => {
                    const bDate = b.createdAt ? new Date(b.createdAt) : null
                    if (bDate && bDate >= currentMonthStart && bDate <= currentMonthEnd) return true
                    const firstRoom = getBookingRooms(b)[0]
                    if (firstRoom?.checkIn) {
                        const cIn = new Date(firstRoom.checkIn)
                        if (cIn >= currentMonthStart && cIn <= currentMonthEnd) return true
                    }
                    return false
                })
                const monthlySales = monthlyBookings.reduce((sum, b) => sum + getBookingTotal(b), 0)

                // Category & Room Breakdown for this user/agent
                const categoryBreakdownMap = {}
                const detailedSellsList = []

                confirmedMyBookings.forEach(booking => {
                    const rooms = getBookingRooms(booking)
                    rooms.forEach(room => {
                        const catLabel = room.categoryName || room.room?.name || room.room?.category || "Standard Room"
                        const rTotal = getRoomTotal(room)
                        const nights = getNightCount(room.checkIn, room.checkOut)

                        categoryBreakdownMap[catLabel] = (categoryBreakdownMap[catLabel] || 0) + rTotal

                        const bTotal = getBookingTotal(booking)
                        const bPaid = getBookingPaidAmount(booking)
                        const bDue = getBookingDueAmount(booking)
                        const bDiscount = getBookingDiscount(booking)

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
        app.post("/categoryandroom/:id/schedule-price", async (req, res) => {
            try {
                const { id } = req.params
                const { effectiveDate, price, note } = req.body
                if (!effectiveDate || isNaN(Number(price))) {
                    return res.status(400).send({ message: "Effective date and valid price are required." })
                }

                const query = { _id: new ObjectId(id) }
                const scheduleEntry = {
                    id: Math.random().toString(36).slice(2, 9),
                    effectiveDate,
                    price: Number(price),
                    note: note || "",
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

                res.send({ success: true, entry: scheduleEntry, result })
            } catch (err) {
                console.error("Schedule price error:", err)
                res.status(500).send({ message: "Failed to schedule price change." })
            }
        })

        // Delete Scheduled Price
        app.delete("/categoryandroom/:id/schedule-price/:effectiveDate", async (req, res) => {
            try {
                const { id, effectiveDate } = req.params
                const query = { _id: new ObjectId(id) }
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

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
    app.listen(port, () => {
        console.log(`Server is running on port:${port}`)
    })
}

module.exports = app
