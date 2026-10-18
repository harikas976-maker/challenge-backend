const { http, HttpResponse, delay } = require('msw');
const { setupServer } = require('msw/node');
const user = require('./mocks/user.json');
const { ApiError } = require('../services/upstream');
const { IdempotencyStore, eventFingerprint } = require('../services/idempotency');
const idempotency = new IdempotencyStore();
 
let requestCount = 0
const userStore = {
  users:{
    "1" : {
      userName: 'user1',
      id: 1,
      email: 'hello@gmail.com',
      events: ['event-1', 'event-3']
    },
    "2" : {
      userName: 'user2',
      id: 2,
      email: 'hello2@gmail.com',
      events: ['event-2']
    },
    "3" : {
      userName: 'user3',
      id: 2,
      email: 'hello3@gmail.com',
      events: ['event-4']
    }
  },
  addUser(user) {
    this.users[user.id] = user;
    return user;
  },
  getUser(id) {
    return Object.hasOwn(this.users, id) ? this.users[id] : undefined;
  },
  getUsers() {
    return Object.values(this.users);
  },
  addEventTouUser(userId, eventId) {
    this.users[userId].events.push(eventId);
  }
}

const eventStore = {
  events: {
    "event-1": {
      id: 1,
      name: 'Event 1',
      userId: 1,
      details: 'This is the first event'
    },
    "event-2": {
      id: 1,
      name: 'Event 2',
      userId: 2,
      details: 'This is the first event'
    },
    "event-3": {
      id: 1,
      name: 'Event 1',
      userId: 1,
      details: 'This is the first event'
    },
    "event-4": {
      id: 1,
      name: 'Event 4',
      userId: 3,
      details: 'This is the first event'
    }
  },
  addEvent(event) {
    this.events[event.id] = event;
    return event;
  },
  getEvent(id) {
    return this.events[id];
  },
  getEvents() {
    return Object.values(this.events);
  }
};


// Provide the server-side API with the request handlers.
const server = setupServer(
  http.get('http://event.com/getUsers', () => {
    if (Math.random() < 0.05) {
      return HttpResponse.error(new Error('Server error occurred'));
    } 
    return HttpResponse.json(userStore.getUsers());
  }),

  http.get('http://event.com/getUserById/:id', ({params}) => {
    const found = userStore.getUser(params.id);
    return found ? HttpResponse.json(found) : HttpResponse.json({ error: 'User not found' }, { status: 404 });
  }),
  
  http.post('http://event.com/addEvent', async ({request}) => {
    const requestBody = await request.json();
    if (typeof requestBody.name !== 'string' || !requestBody.name.trim() || requestBody.userId == null || requestBody.id == null) {
      return HttpResponse.json({ error: 'Invalid event' }, { status: 400 });
    }
    if (!userStore.getUser(requestBody.userId)) {
      return HttpResponse.json({ error: 'User not found' }, { status: 404 });
    }
    async function commit() {
      requestCount++;
      // Preserve five successful writes followed by ten failed attempts.
      if (requestCount <= 5) {
        eventStore.addEvent(requestBody);
        userStore.addEventTouUser(requestBody.userId, requestBody.id);
        return { success: true };
      }
      if (requestCount >= 15) requestCount = 0;
      await delay(100);
      throw new ApiError(503, 'Service temporarily unavailable');
    }
    try {
      const key = request.headers.get('Idempotency-Key');
      const result = key ? await idempotency.execute(key, eventFingerprint(requestBody), commit) : await commit();
      return HttpResponse.json(result);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return HttpResponse.json({ success: false, error: error.message }, {
        status: error.statusCode,
        headers: error.retryAfterSeconds ? { 'Retry-After': String(error.retryAfterSeconds) } : {}
      });
    }
  }),
  http.get('http://event.com/getEvents', () => {
    if (Math.random() < 0.05) {
      return HttpResponse.error(new Error('Server error occurred'));
    } 
    return HttpResponse.json(eventStore.getEvents())
  }),
  http.get('http://event.com/getEventById/:id', async ({params}) => {
    await delay(500);
    return HttpResponse.json(eventStore.getEvent(params.id))
  }),
)

const listenMock = () => {
  // Start the interception.
  server.listen()
}

module.exports = listenMock;
module.exports.close = () => server.close();
