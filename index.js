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

const getBookingTotal = (booking = {}) => {
    const rooms = getBookingRooms(booking)
    if (rooms.length) {
        const total = rooms.reduce((sum, room) => sum + getRoomTotal(room), 0)
        return total || Number(booking.totalAmount || 0)
    }
    return Number(booking.totalAmount || 0)
}

const getRoomIdsForLookup = (bookings = []) => {
    return [...new Set(bookings.flatMap(booking => getBookingRooms(booking).map(room => room.roomId).filter(Boolean)))]
}

const hydrateBookingsWithRooms = async (bookings = [], roomCollection) => {
    const roomIds = getRoomIdsForLookup(bookings)
    const objectIds = roomIds.map(toObjectId).filter(Boolean)
    const roomDocs = objectIds.length
        ? await roomCollection.find({ _id: { $in: objectIds } }).toArray()
        : []
    const roomMap = new Map(roomDocs.map(room => [String(room._id), room]))

    return bookings.map(booking => {
        const rooms = getBookingRooms(booking).map(room => ({
            ...room,
            room: roomMap.get(String(room.roomId)) || room.room || null
        }))
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

async function run() {
    try {
        const db = client.db("miami_beach_resort_db")
        // collections
        const userCollection = db.collection("users")
        const roomCollection = db.collection("rooms")
        const bookingCollection = db.collection("bookings")
        const categoryAndRoomCollection = db.collection("categoryandroom")

        await ensureBookingIdIndex(bookingCollection)
        startRequestBookingAutoCancelJob(bookingCollection)

        // jwt verify
        const verifyFBToken = async (req, res, next) => {
            const authHeader = req.headers.authorization
            const token = authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1] : authHeader

            if (token) {
                try {
                    if (admin.apps?.length > 0) {
                        const decoded = await admin.auth().verifyIdToken(token)
                        req.decodedEmail = decoded.email
                        req.decodedUid = decoded.uid
                        return next()
                    }
                } catch (e) {
                    // fallback to payload decoding below
                }

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
                } catch (err) {
                    console.error("JWT payload parse error:", err)
                }
            }
            next()
        }

        // admin verify
        const verifyAdmin = async (req, res, next) => {
            const email = req.decodedEmail || req.headers['x-user-email']
            if (!email) {
                return res.status(403).send({ message: "Unauthorized Access" })
            }
            const query = { email: { $regex: `^${email}$`, $options: "i" } }
            const options = { projection: { role: 1, _id: 0 } }
            const result = await userCollection.findOne(query, options)
            if (result?.role !== "admin") {
                return res.status(403).send({ message: "Unauthorized Access" })
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

                if (!adminUser || adminUser.role !== "admin") {
                    return res.status(403).send({ message: "Only administrators can modify roles" })
                }

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

        // all users for admin
        app.get("/users", verifyFBToken, verifyAdmin, async (req, res) => {
            const { search } = req.query
            const query = {}
            if (search) {
                query.name = { $regex: search, $options: "i" }
            }
            const result = await userCollection.find(query).sort({ _id: -1 }).toArray()
            res.send(result)
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

        app.post("/bookings", async (req, res) => {
            const data = req.body
            const rooms = normalizeBookingRooms(data)
            const validationError = validateBookingRooms(rooms)

            if (validationError) {
                return res.status(400).send({ message: validationError })
            }

            for (const room of rooms) {
                const targetCategoryId = room.categoryId || room.roomId
                const catObjectId = toObjectId(targetCategoryId)
                const category = catObjectId ? await categoryAndRoomCollection.findOne({ _id: catObjectId }) : null

                if (category && Array.isArray(category.roomNumbers) && category.roomNumbers.length > 0) {
                    const totalCategoryRooms = category.roomNumbers.length

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

                    if ((alreadyBookedCount + requestedCount) > totalCategoryRooms) {
                        const remaining = Math.max(0, totalCategoryRooms - alreadyBookedCount)
                        return res.status(409).send({
                            message: `Category "${category.name}" only has ${remaining} room(s) available from ${room.checkIn} to ${room.checkOut}.`
                        })
                    }
                } else if (room.roomNo) {
                    // Physical room check
                    const existingBooking = await findRoomConflict(bookingCollection, room)
                    if (existingBooking) {
                        const conflictingRoom = getBookingRooms(existingBooking).find(existingRoom =>
                            String(existingRoom.roomId) === String(room.roomId) &&
                            existingRoom.checkIn < room.checkOut &&
                            existingRoom.checkOut > room.checkIn
                        )
                        return res.status(409).send({
                            message: `Room ${room.roomNo} is already reserved from ${conflictingRoom?.checkIn || existingBooking.checkIn} to ${conflictingRoom?.checkOut || existingBooking.checkOut}. Please select different dates or another room.`,
                            conflictBookingId: existingBooking.bookingId
                        })
                    }
                }
            }

            const today = new Date()
            const requestedByRole = data.requestedByRole || data.role || "user"
            const expireHours = getRequestBookingExpireHours(requestedByRole)
            const requestExpiresAt = new Date(today.getTime() + expireHours * 60 * 60 * 1000)
            const bookingData = {
                name: data.name,
                mobile: data.mobile,
                address: data.address || "",
                userEmail: data.userEmail || data.email || "",
                rooms,
                advanceAmount: Number(data.advanceAmount || 0),
                createdAt: today,
                requestedByRole,
                requestExpiresAt,
                status: BOOKING_STATUS.REQUEST_BOOKING,
                statusHistory: [{ status: BOOKING_STATUS.REQUEST_BOOKING, time: today }]
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
        })

        app.get("/bookings", verifyFBToken, async (req, res) => {
            const { email, status, skip, limit } = req.query
            let query = {}
            let sort = { _id: -1 }
            if (email) query.userEmail = email
            if (status) {
                if (Array.isArray(status)) {
                    query.status = { $in: status }
                } else {
                    query.status = status
                }
            }
            const bookings = await bookingCollection
                .find(query)
                .sort(sort)
                .skip(Number(skip) || 0)
                .limit(Number(limit) || 0)
                .toArray()
            const result = await hydrateBookingsWithRooms(bookings, roomCollection)
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
            const [result] = await hydrateBookingsWithRooms(booking ? [booking] : [], roomCollection)
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

            const update = { $set: updateData }

            if (status) {
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

            const roomNumbers = Array.isArray(category.roomNumbers) ? category.roomNumbers : []
            if (roomNumbers.length === 0) {
                return res.send({ available: true, message: "Category has rooms available." })
            }

            // Find all rooms in the rooms collection matching these room numbers
            const matchingRooms = await roomCollection.find({
                roomNo: { $in: roomNumbers },
                status: "active"
            }).toArray()

            if (matchingRooms.length === 0) {
                // No rooms tracked in rooms collection — allow booking
                return res.send({ available: true, message: "Category has rooms available." })
            }

            // For each room, check if it has an active booking conflicting with the dates
            let anyAvailable = false
            for (const room of matchingRooms) {
                const conflict = await findRoomConflict(bookingCollection, {
                    roomId: String(room._id),
                    checkIn,
                    checkOut
                })
                if (!conflict) {
                    anyAvailable = true
                    break
                }
            }

            if (anyAvailable) {
                res.send({ available: true, message: "Rooms are available in this category for the selected dates." })
            } else {
                res.send({
                    available: false,
                    message: `No rooms are available in this category from ${checkIn} to ${checkOut}. Please try different dates.`
                })
            }
        })

        app.delete('/categoryandroom/:id', async (req, res) => {
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
            const allBookings = await bookingCollection.find().sort({ _id: -1 }).toArray()
            const hydratedBookings = await hydrateBookingsWithRooms(allBookings, roomCollection)
            const confirmedBookings = hydratedBookings.filter(booking =>
                [BOOKING_STATUS.BOOKING_CONFIRMED, BOOKING_STATUS.CHECKED_IN, BOOKING_STATUS.CHECKED_OUT, "confirmed"].includes(booking.status)
            )

            const roomStats = {}
            confirmedBookings.forEach(booking => {
                const rooms = getBookingRooms(booking)
                rooms.forEach(room => {
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
                        status: booking.status,
                        createdAt: booking.createdAt
                    })
                })
            })

            res.send({
                totalRevenue: confirmedBookings.reduce((sum, b) => sum + getBookingTotal(b), 0),
                totalConfirmedBookings: confirmedBookings.length,
                roomBreakdown: Object.values(roomStats).sort((a, b) => b.totalRevenue - a.totalRevenue)
            })
        })


        console.log("Pinged your deployment. You successfully connected to MongoDB!")
    } finally {
        // await client.close()
    }
}
run().catch(console.dir)

app.listen(port, () => {
    console.log(`Server is running on port:${port}`)
})
