const express = require("express")
const app = express()
app.use(express.json())
const cors = require("cors")
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb')
const cloudinary = require('cloudinary').v2
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

async function run() {
    try {
        const db = client.db("miami_beach_resort_db")
        // collections
        const userCollection = db.collection("users")
        const roomCollection = db.collection("rooms")
        const bookingCollection = db.collection("bookings")
        const categoryAndPricingCollection = db.collection("category&pricing")


        // jwt verify
        const verifyFBToken = async (req, res, next) => {
            // const token = req.headers.authorization?.split(" ")[1]
            // if (!token) {
            //     return res.status(401).send({ message: "Unauthorized Access" })
            // }
            // try {
            //     if (admin.apps?.length > 0) {
            //         const decoded = await admin.auth().verifyIdToken(token)
            //         req.decodedEmail = decoded.email
            //         return next()
            //     }
            //     // Fallback JWT payload decoder when admin SDK key is not yet set
            //     const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf-8'))
            //     req.decodedEmail = payload.email
            //     next()
            // } catch (error) {
            //     try {
            //         const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf-8'))
            //         if (payload?.email) {
            //             req.decodedEmail = payload.email
            //             return next()
            //         }
            //     } catch (e) { }
            //     return res.status(403).send({ message: "Unauthorized Access" })
            // }
            next()
        }

        // admin verify
        const verifyAdmin = async (req, res, next) => {
            // const email = req.decodedEmail
            // if (!email) {
            //     return res.status(403).send({ message: "Unauthorized Access" })
            // }
            // const query = { email: { $regex: `^${email}$`, $options: "i" } }
            // const options = { projection: { role: 1, _id: 0 } }
            // const result = await userCollection.findOne(query, options)
            // if (result?.role !== "admin") {
            //     return res.status(403).send({ message: "Unauthorized Access" })
            // } else {
            //     return next()
            // }
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
                const adminQuery = { email: { $regex: `^${req.decodedEmail}$`, $options: "i" } }
                const adminUser = await userCollection.findOne(adminQuery)
                if (adminUser?.role !== "admin") {
                    return res.status(403).send({ message: "Only administrators can modify roles" })
                }
                const targetUser = await userCollection.findOne(query)
                if (targetUser?.email?.toLowerCase() === req.decodedEmail?.toLowerCase()) {
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
            const query = { _id: new ObjectId(id) }
            const result = await roomCollection.findOne(query)
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
            const { roomId, roomCategory, checkIn, checkOut } = req.query
            if (!checkIn || !checkOut) {
                return res.status(400).send({ available: false, message: "Check-in and Check-out dates are required" })
            }

            let roomFilter = {}
            if (roomId) {
                try {
                    roomFilter = { $or: [{ roomId: roomId }, { _id: new ObjectId(roomId) }] }
                } catch (e) {
                    roomFilter = { roomId: roomId }
                }
            } else if (roomCategory) {
                roomFilter = { roomCategory: roomCategory }
            }

            const conflictQuery = {
                status: { $in: ["pending", "confirmed"] },
                ...roomFilter,
                checkIn: { $lt: checkOut },
                checkOut: { $gt: checkIn }
            }

            const existingBooking = await bookingCollection.findOne(conflictQuery)
            if (existingBooking) {
                return res.send({
                    available: false,
                    message: `Room is already reserved from ${existingBooking.checkIn} to ${existingBooking.checkOut}. Please select different dates or another room.`,
                    conflict: existingBooking
                })
            }
            res.send({ available: true, message: "Room is available for selected dates." })
        })
        // Get all active reserved date ranges for rooms (for calendar / availability preview)
        app.get("/bookings/reserved-dates", async (req, res) => {
            const { roomId } = req.query
            const query = { status: { $in: ["pending", "confirmed"] } }
            if (roomId) {
                query.roomId = roomId
            }
            const options = {
                projection: { roomId: 1, roomName: 1, roomCategory: 1, checkIn: 1, checkOut: 1, status: 1, _id: 0 }
            }
            const result = await bookingCollection.find(query, options).toArray()
            res.send(result)
        })

        app.post("/bookings", async (req, res) => {
            const data = req.body
            const { roomId, roomCategory, checkIn, checkOut } = data

            if (!checkIn || !checkOut) {
                return res.status(400).send({ message: "Check-in and Check-out dates are required" })
            }

            if (new Date(checkOut) <= new Date(checkIn)) {
                return res.status(400).send({ message: "Check-out date must be after check-in date" })
            }

            // Check for date collision on the same room
            let roomFilter = {}
            if (roomId) {
                roomFilter = { $or: [{ roomId: roomId }, { _id: new ObjectId(roomId) }] }
            } else if (roomCategory) {
                roomFilter = { roomCategory: roomCategory }
            }

            const conflictQuery = {
                status: { $in: ["pending", "confirmed"] },
                ...roomFilter,
                checkIn: { $lt: checkOut },
                checkOut: { $gt: checkIn }
            }

            const existingBooking = await bookingCollection.findOne(conflictQuery)
            if (existingBooking) {
                return res.status(409).send({
                    message: `Room is already reserved from ${existingBooking.checkIn} to ${existingBooking.checkOut}. Please select different dates or another room.`,
                    conflictBookingId: existingBooking.bookingId
                })
            }

            const today = new Date()
            const date = today.toISOString().split("T")[0].replaceAll("-", "")
            const random = Math.random().toString(36).slice(2, 8).toUpperCase()
            const bookingId = `BK-${date}-${random}`

            data.bookingId = bookingId
            data.createdAt = today
            data.status = "pending"
            data.statusHistory = [{ status: "pending", time: today }]

            const result = await bookingCollection.insertOne(data)
            result.bookingId = bookingId
            res.send(result)
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
            const result = await bookingCollection
                .find(query)
                .sort(sort)
                .skip(Number(skip) || 0)
                .limit(Number(limit) || 0)
                .toArray()
            if (skip || limit) {
                const totalDataCount = await bookingCollection.countDocuments(query)
                res.send({ result, totalDataCount })
                return
            }
            res.send(result)
        })

        app.get("/booking/:id", verifyFBToken, async (req, res) => {
            const { id } = req.params
            const query = { _id: new ObjectId(id) }
            const result = await bookingCollection.findOne(query)
            res.send(result)
        })

        app.patch("/booking/:id", verifyFBToken, async (req, res) => {
            const { id } = req.params
            const { status } = req.body
            const query = { _id: new ObjectId(id) }
            const now = new Date()
            const update = {
                $set: { status },
                $push: { statusHistory: { status, time: now } }
            }
            const result = await bookingCollection.updateOne(query, update)
            res.send(result)
        })

        app.delete("/booking/:id", verifyFBToken, verifyAdmin, async (req, res) => {
            const { id } = req.params
            const query = { _id: new ObjectId(id) }
            const result = await bookingCollection.deleteOne(query)
            res.send(result)
        })
        // category and pricing 
        app.get("/categoryandpricing", async (req, res) => {
            const result = await categoryAndPricingCollection.find().toArray()
            res.send(result)
        })
        app.patch("/categoryandpricing/:id", async (req, res) => {
            const { id } = req.params
            const data = req.body
            data.updatedAt = new Date()
            const query = { _id: new ObjectId(id) }
            const update = { $set: data }
            const result = await categoryAndPricingCollection.updateOne(query, update)
            res.send(result)
        })
        app.post("/categoryandpricing", async (req, res) => {
            const data = req.body
            data.createdAt = new Date()
            data.updatedAt = new Date()
            const result = await categoryAndPricingCollection.insertOne(data)
            res.send(result)
        })
        app.delete('/categoryandpricing/:id', async (req, res) => {
            const { id } = req.params
            const query = { _id: new ObjectId(id) }
            const result = await categoryAndPricingCollection.deleteOne(query)
            res.send(result)
        })


        // ADMIN OVERVIEW ..............................................
        app.get("/admin/overview", verifyFBToken, verifyAdmin, async (req, res) => {
            const dataFromBookings = (await bookingCollection.aggregate([{
                $facet: {
                    statusCounts: [
                        { $group: { _id: "$status", count: { $sum: 1 } } }
                    ],
                    totalRevenue: [
                        { $match: { status: "confirmed" } },
                        { $group: { _id: null, total: { $sum: "$totalAmount" } } }
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
                    ],
                    bookingsPerRoom: [
                        { $group: { _id: { $ifNull: ["$roomName", "$roomCategory"] }, count: { $sum: 1 } } },
                        { $sort: { count: -1 } }
                    ]
                }
            }]).toArray())[0]

            const statusMap = {}
            dataFromBookings.statusCounts.forEach(s => { statusMap[s._id] = s.count })

            const result = {
                totalBookings: (statusMap.pending || 0) + (statusMap.confirmed || 0) + (statusMap.cancelled || 0),
                confirmedCount: statusMap.confirmed || 0,
                pendingCount: statusMap.pending || 0,
                cancelledCount: statusMap.cancelled || 0,
                totalRevenue: dataFromBookings.totalRevenue[0]?.total || 0,
                bookingsPerDay: dataFromBookings.bookingsPerDay,
                bookingsPerRoom: dataFromBookings.bookingsPerRoom
            }
            res.send(result)
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
