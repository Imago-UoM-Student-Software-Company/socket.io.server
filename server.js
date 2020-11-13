// jshint esversion: 6

// express code

const express = require('express');
const app = express();

const http = require('http').Server(app);

app.use(express.static(__dirname));

app.get('/', function (req, res) {
  res.sendFile(__dirname + '/index.html');
});
process.on('uncaughtException', (err) => {
  console.error('There was an uncaught error', err);
  process.exit(1); //mandatory (as per the Node.js docs)
});
// end express code

// setup Socket.io Server and Proxy
const url = require('url');
const base64id = require('base64id');
const port = process.env.PORT || 3003;
const io = require('socket.io')(http);
// overload to use passed in ID as socket.id
io.engine.generateId = (req) => {
  const parsedUrl = new url.parse(req.url);
  const params = new URLSearchParams(parsedUrl.search);
  const prevId = params.get('id');
  // prevId is either a valid id or an empty string
  if (prevId) {
    return prevId;
  }
  return base64id.generateId();
};

// set up Server Proxy
const { getNow, printJson, logResults, ServerProxy } = require('./radar');
let pendingWarnings = new Map();
const S = new ServerProxy(io, pendingWarnings);

// other utilities
const clc = require('cli-color');
const success = clc.red.green;
const colorExposureAlert = clc.green;
const colorExposureWarning = clc.yellow.red;
const error = clc.red.bold;
const warn = clc.yellow;
const info = clc.cyan;
const notice = clc.blue;
const highlight = clc.magenta;
const bold = clc.bold;

const moment = require('moment');
const DEBUG = 0;

const { SOURCE, ROOM_TYPE } = require('./types');

// helpers

function onConnection(query) {
  console.groupCollapsed(
    `[${getNow()}] EVENT: onConnection [${
      query.visitor || query.room || query.admin
    }] ${query.state ? query.state : ''}`
  );

  let result = handlePendings(query);

  query.result = result;
  console.log('Sockets:', printJson(S.sockets));
  console.log('Available Rooms:', printJson(S.available));
  console.log('Rooms:', printJson(S.rooms));
  console.log('Socket Room State:', query.state);
  console.log('Open Rooms:', printJson(S.openRooms));
  console.log('Visitors:', printJson(S.visitors));
  console.groupEnd();
  S.exposeOpenRooms();
}

function handlePendings(query) {
  console.log('Pending Warnings:', printJson([...pendingWarnings]));

  if (query.room) {
    if (!pendingWarnings.has(query.room)) {
      let msg = `Nothing pending for ${query.room}`;
      console.log(msg);
      return msg;
    }

    pendingWarnings.forEach((value, key) => {
      const message = {
        visitor: '',
        exposureDates: value.warnings[key].dates,
        room: key,
      };
      S.privateMessage(query.room, 'notifyRoom', message);
      pendingWarnings.delete(key);
      console.groupCollapsed(`Pending Warnings for ${query.room}:`);

      console.log(warn(JSON.stringify(message, null, 3)));
      console.groupEnd();
    });
  } else if (query.visitor || query.admin) {
    if (!pendingWarnings.size || !pendingWarnings.has(query.visitor)) {
      let msg = `Nothing pending for ${query.visitor}`;
      console.log(msg);
      return msg;
    }

    pendingWarnings.forEach((value, key) => {
      const message = {
        visitor: key,
        exposureDates: value,
        room: '',
      };
      privateMessage(query.id, 'exposureAlert', message);
      console.groupCollapsed('Pending Alerts:');

      console.log(warn(JSON.stringify(message, null, 3)));
      console.groupEnd();
      pendingWarnings.delete(key);
    });
  }
}

// end helpers

// Heavy lifting below
//=============================================================================//

io.on('reconnect', (socket) => {
  // immediately reconnection
  if (socket.handshake.query.id) {
    handlePendings(socket.handshake.query);
    console.table(S.sockets);
  }
});

// called when a connection changes
io.on('connection', (socket) => {
  const query = socket.handshake.query;
  // block undefined Rooms

  // immediately upon connection: check for pending warnings and alerts
  if (query.id) {
    if (query.room && query.state === 'Opened') {
      console.group(`[${getNow()}] Reopening ${query.room}`);
      socket.join(query.room);
      console.log('Open Rooms:', printJson(S.exposeOpenRooms()));
      console.groupEnd();
    }
    onConnection(query);
  } else {
    console.group('Odd Socket. Disconnecting');
    console.error('socket lacks ID:', socket.handshake.query);
    socket.disconnect(true);
    console.groupEnd();
  }
  //...........................................................................//
  //#region Listeners

  //#region Open/Close Room
  // called by State Machine to bring a Room online
  // so that Visitors can enter
  // this can change the state of io...rooms
  // next step in the pipeline is to access pending Visitor exposure warnings
  const onOpenRoom = (data, ack) => {
    try {
      const { room, id } = data;
      // console.log(message, socket.handshake.query);
      console.groupCollapsed(`[${getNow()}] EVENT: onOpenRoom ${room}`);

      console.log(`Open Rooms before ${room} opens...`);
      console.log(S.openRooms);

      socket.join(room);

      console.log(`...and after ${room} opens`);
      console.log(printJson(S.exposeOpenRooms()));
      console.log('Sockets');
      console.log(printJson(S.sockets));
      console.log('Available');
      console.log(printJson(S.available));
      console.log('Rooms');
      console.log(printJson(S.openRooms));

      console.log('Emitted exposeOpenRooms event');

      console.log('Pending Warnings:');
      console.log(printJson([...pendingWarnings]));

      // check for pending warnings
      handlePendings(socket.handshake.query);
      // if this checks for connection, why not check Room connected property?
      const assertion = S.roomIdsIncludeSocket(room, id);

      console.assert(assertion, `${id} unable to join ${room}`);

      if (ack) {
        ack({ event: 'onOpenRoom', room: room, result: assertion });
      }
    } catch (error) {
      console.groupEnd();
      console.error('Oops, onOpenRoom() hit this:', error.message);
    } finally {
      console.groupEnd();
    }
  };

  const onCloseRoom = function (data, ack) {
    try {
      const { room, id, nsp } = data;
      console.groupCollapsed(`[${getNow()}] EVENT: onCloseRoom [${room}]`);
      console.log(`Rooms before ${room} closing...`);
      console.log(printJson(S.openRooms));
      socket.leave(room);
      console.log(`...after ${room} closing`);
      console.log(printJson(S.openRooms));
      console.log('Sockets');
      console.log(printJson(S.sockets));
      console.log('Rooms');
      console.log(printJson(S.openRooms));

      // if this checks for connection, why not check Room connected property?
      const assertion = !S.roomIdsIncludeSocket(room, id);

      console.assert(assertion, `${id} unable to leave ${room}`);

      if (ack) {
        ack({ event: 'onCloseRoom', room: room, result: assertion });
      }
    } catch (error) {
      console.groupEnd();
      console.error('Oops, closeRoom() hit this:', error.message);
    } finally {
      console.groupEnd();
    }
  };
  //#endregion

  //#region Enter/Leave Room
  // Visitor sends this event
  const onEnterRoom = (data, ack) => {
    try {
      const { room, id, nsp, sentTime, visitor } = data;
      console.groupCollapsed(`[${getNow()}] EVENT: onEnterRoom ${room}`);

      // first, ensure the Room is open (note S.rooms returns an object
      // that will include the name of an Open Room after a Room opens its own
      // io room):
      if (!S.rooms[room.room]) {
        if (ack) {
          ack({
            error: 'Room must be open before you can enter',
            on: 'server.onEnterRoom',
          });
        }
      }

      // Enter the Room. As others enter, you will see a notification they, too, joined.
      socket.join(room.room);

      //S.roomIdsIncludeSocket essentially calls:
      //const result = io.nsps['/'].adapter.rooms
      // && io.nsps['/'].adapter.rooms[room.room].sockets[socket.id];
      const assertion = S.roomIdsIncludeSocket(room.room, socket.id);
      console.assert(assertion, 'Could not enter Room', room.room);

      // handled by Room.checkIn()
      // sending to individual socketid (private message)
      // this emit assumes the room.room is open (and not merely connected)
      io.to(room.room).emit('checkIn', {
        visitor: visitor,
        sentTime: sentTime,
        room: room,
        message: 'Entered',
        socketId: socket.id,
      });

      const occupants = S.getOccupancy(room.room);
      console.log(warn(`${room.room} has ${occupants} occupants now:`));
      console.log(printJson(S.rooms[room.room]));
      if (occupants) {
        if (ack) {
          ack({
            event: 'onEnterRoom',
            room: room,
            occupants: occupants,
            result: assertion,
            emits: 'checkIn',
          });
        }
      } else {
        if (ack) {
          ack({
            event: 'onEnterRoom',
            room: room,
            result: `Could not enter Room ${room.room}`,
            emits: 'nothing',
          });
        }
      }
      console.groupEnd();
    } catch (error) {
      console.groupEnd();
      console.error('Oops, onEnterRoom() hit this:', error);
    } finally {
      console.groupEnd();
    }
  };

  const onLeaveRoom = (data, ack) => {
    const { room, visitor, sentTime, message } = data;
    console.groupCollapsed(`[${getNow()}] EVENT: onLeaveRoom ${room.room}`);
    socket.leave(room.room);

    // handled by Room.checkOut()
    // sending to individual socketid (private message)
    io.to(room.room).emit('checkOut', {
      visitor: visitor,
      sentTime: sentTime,
      room: room,
      message: message,
    });

    S.updateOccupancy(room.room);

    const msg = `Using their own socket ${socket.id}, ${visitor.visitor} ${
      S.roomIdsIncludeSocket(room.room, socket.handshake.query.id)
        ? 'did not make it out of'
        : 'made it out of'
    } Room [${room.room} ${room.id}] on ${getNow()}`;

    console.log(warn('leaveRoom():', msg));
    if (ack) {
      ack(msg);
    }
  };
  //#endregion

  //#region Warnings and Alerts
  // Visitor sends this event containing all warnings for all exposed Rooms
  const onExposureWarning = (data, ack) => {
    try {
      const { visitor, warnings } = data;
      console.groupCollapsed(
        `[${getNow()}] EVENT: onExposureWarning from [${visitor.visitor}]`
      );
      console.log('Warning data:');
      console.log(printJson(data));
      let results = [];

      // iterate collection notifying each Room separately
      Object.entries(warnings).forEach((warning) => {
        let roomName = warning[0];
        console.log('Open Rooms:');
        console.log(printJson(S.openRooms));
        if (S.openRooms.filter((v) => v.room == roomName).length) {
          console.log(`${roomName} is open. Emitting event.`);
          results.push(S.notifyRoom({ warning: warning, visitor: visitor }));
        } else {
          results.push(`${roomName} PENDING`);
          console.warn(`${roomName} is closed. caching event.`);
          pendingWarnings.set(roomName, data);
        }
      });
      console.warn('Pending Warnings:');
      console.warn(printJson([...pendingWarnings]));

      if (ack) {
        ack({
          event: 'onExposureWarning',
          result: results.flat(),
          emit: 'notifyRoom',
        });
      }
    } catch (error) {
      console.groupEnd();
      console.error('onExposureWarning sees:', error);
    } finally {
      console.groupEnd();
    }
  };

  // Room sends this event
  // Server forwards content to Visitor(s) with exposureAlert event
  function onAlertVisitor(data, ack) {
    // Visitor message includes the Room names to alert
    try {
      const { message, visitor, id } = data;
      console.groupCollapsed(
        `[${getNow()}] EVENT: onAlertVisitor [${visitor}]`
      );
      if (!message || !visitor) {
        if (ack) {
          ack(
            new error(
              `${
                message ? 'Missing visitor identity' : 'No message to process'
              }`
            )
          );
        }
        return;
      }
      let result;
      // send or cache the alert
      console.log(`Alerting ${visitor}`);
      // Ensure Visitor is online to see alert, otherwise cache and send when they login again
      if (S.visitors.filter((v) => v.visitor === visitor).length) {
        // sending to visitor socket in visitor's room (except sender)
        result = S.alertVisitor(data);
      } else {
        // cache the Visitor warning
        pendingWarnings.set(visitor, data);

        return `Server: ${visitor} unavailable. DEFERRED ALERT.`;
      }

      if (ack) {
        ack(result);
      }
    } catch (error) {
      console.groupEnd();
      console.error('ERROR: onAlertVisitor sees:', error);
    } finally {
      console.groupEnd();
    }
  }
  //#endregion

  //#endregion end listeners
  //...........................................................................//

  //+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++//
  // Socket Events
  // Rooms send these events
  socket.on('openRoom', onOpenRoom); // sent from Room for each visitor
  socket.on('closeRoom', onCloseRoom);
  // (each Visitor warned each Room the date(s) Visitor occupied the Room)
  socket.on('alertVisitor', onAlertVisitor);

  // sent from Visitor
  // Visitor sends this message:
  // {visitor:{name, id, nsp}, room:{room, id, nsp}, message:{}, sentTime: dateTime}
  // disambiguate enterRoom event from the event handler in the Room, checkIn
  socket.on('enterRoom', onEnterRoom);
  // disambiguate leaveRoom event from the event handler in the Room, checkOut
  socket.on('leaveRoom', onLeaveRoom);
  socket.on('exposureWarning', onExposureWarning);

  // end Socket Events
  //+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++//

  // Admin events (for Room managers use)

  socket.on('exposeAllSockets', (data, ack) => {
    if (ack) {
      ack(S.sockets);
    }
  });
  socket.on('exposeOpenRooms', (data, ack) => {
    if (ack) {
      ack(S.exposeOpenRooms());
    }
  });
  socket.on('exposePendingWarnings', (data, ack) => {
    if (ack) {
      ack(pendingWarnings);
    }
  });
  socket.on('exposeAvailableRooms', (data, ack) => {
    if (ack) {
      ack(S.available);
    }
  });
  socket.on('exposeVisitorsRooms', (data, ack) => {
    if (ack) {
      ack(S.visitors);
    }
  });

  socket.on('pingServer', function (data, ack) {
    if (ack) ack(`Server is at your disposal, ${data}`);
  });

  socket.on('disconnect', () => {
    console.log('Remaining Sockets:');
    console.table(printJson(S.sockets));
  });

  socket.on('disconnecting', (reason) => {
    console.log(
      `[${getNow()}] EVENT: onDisconnecting ${printJson(
        socket.handshake.query
      )}`
    );
    console.warn(
      getNow(),
      `Disconnecting Socket ${
        socket.handshake.query.visitor ||
        socket.handshake.query.room ||
        socket.handshake.query.admin
      } (${socket.id}) `
    );
    if (socket.handshake.query.room) {
      console.log(printJson(S.openRooms));
    }
    console.log(`[${getNow()}] ${printJson(Object.keys(socket.rooms))}`);
    console.warn('\tReason:', reason);
    console.groupEnd();
  });

  socket.on('disconnectAll', () => {
    Object.values(io.sockets.clients().connected).map((v) => v.disconnect());
    console.log('Remaining connections :>> ', io.sockets.connected);
  });
});

http.listen(port, function () {
  console.log(notice('Build: 10.06.16.27'));
  console.log(notice(moment().format('llll')));
  console.log(
    notice(`socket.io server listening on http://localhost: ${port}`)
  );
  console.log();
});
