var sticky = require('socketio-sticky-session');	
var CONSTANTS = require('./constants.js');

var server = sticky(function() {
  
	var CONSTANTS = require('./constants.js');
	var express = require('express');
	var routes = require('./routes/routes');
	var auth = require('./routes/auth');
	var csrf = require('csurf');
	var morgan = require('morgan');
	var middlewares = require('./middlewares');
	var path = require('path');
	var bodyParser = require('body-parser');
	var expressHbs = require('express-handlebars');
	var cookieParser = require('cookie-parser');
	var sharedSession = require("express-socket.io-session");
	var utils = require('./utils/utils.js');
	var gameUtils = require('./utils/gameUtils.js');
	var async = require('async');
	var process = require('process');

	var app = express();
	var server = require('http').Server(app);
	var io = require('socket.io')(server);
	var socketRedis = require('socket.io-redis');
	io.adapter(socketRedis({ host: 'localhost', port: 6379 }));

	var redis = require('redis');
	var redisClient = redis.createClient();

	app.use(express.static(path.join(__dirname,'/client')));
	app.set('views', path.join(__dirname, '/client/views/'));
	app.engine('handlebars', expressHbs({extname: '.hbs'}));
	app.set('view engine', 'handlebars');
	app.set('view options', {
	    layout: false
	});

	app.use(bodyParser.urlencoded({ extended: true })); 
	app.use(bodyParser.json());
	app.use(cookieParser());

	var MongoStore = require('connect-mongo')(require('express-session'));

	app.use(morgan('dev'));

	//setup session
	var session = require('express-session')({
		secret: CONSTANTS.sessionSecretKey,
	    resave: false,
	    saveUninitialized: false,
	    store: new MongoStore({
	      	url: CONSTANTS.dbUrl,
	      	autoRemove: 'native' 
	    }), 
	    cookie: {
		    //httpOnly: true, // when true, cookie is not accessible from javascript 
		    //secure: false, // when true, cookie will only be sent over SSL. use key 'secureProxy' instead if you handle SSL not in your node process 
			maxAge: CONSTANTS.sessionDuration
		}
	});

	app.use(session);

	//setup socket.io sessions
	io.use(sharedSession(session, {
	    autoSave:true
	}));

	//setup csrf to prevent csrf attacks
	app.use(csrf({cookie: true}));

	app.use(middlewares.authenticate);

	app.use(routes);
	app.use(auth);

	var GameTimer;			//to keep a record of the timerId of the setInterval of the game loop

	//on connection of redis 
	redisClient.on('connect', function(){
		//on connection of socket.io
		io.on('connection', function(socket){

			console.log('worker.process.id:' + process.pid);
	
			//event listener and returns all available rooms 
			socket.on('getRooms', function(data){
				//if user session exists
				if(socket.handshake.session.user) {
					async.waterfall([
						//get all the rooms that exist on this namespace
						function(callback){
							io.of('/').adapter.allRooms(function (err, rooms) {
								if(err) {
									err.message = 'Something bad happened. Please try again.';
									return callback(err, null);
								} else {
									return callback(null, rooms);
								}
							});		
						},
						//remove those rooms which are created by the socketIds
						function(rooms, callback){
							io.of('/').adapter.clients(function (err, clients) {
								if(err) {
									err.message = 'Something bad happened. Please try again.';
									return callback(err, null);
								} else {
									clients.forEach(function(client){
										if(rooms.indexOf(client) != -1) {
											rooms.splice(rooms.indexOf(client), 1);
										}
									});
									return callback(null, rooms);
								}
							});	
						}
					], function(err, rooms){
						if(err) {
					  		socket.emit('roomListFetchError', {errorMsg: err.message});
					  	} else {
					  		//emit the room list 
					  		socket.emit('roomList', {rooms: rooms}); 
						}
					});
				} else {
					socket.emit('roomListFetchError', {errorMsg: 'Sorry User could not be authenticated!! Please try again.'});
				}
			});
			
			//event listener for the request to create a room
			socket.on('createRoom', function(roomDetails){
				//if user session exists
				if(socket.handshake.session.user) {
					//create the room in redis client
					redisClient.del(socket.id+'||'+roomDetails.roomName+'||'+socket.handshake.session.user.name);
					redisClient.set(socket.id+'||'+roomDetails.roomName+'||'+socket.handshake.session.user.name,roomDetails.password);
					//make the socket leave all rooms except the one with its own id and join this new room hence creating it 
					utils.createRoom(io, socket, roomDetails, function(status){
						//if creation of room was successful
						if(status) {
							//create roomDetails object
							roomDetails.ownerName = socket.handshake.session.user.name;
							roomDetails.ownerSocketId = socket.id;
							delete roomDetails.password;
							socket.emit('createdRoom', roomDetails);
							//update to the client about the creation of the room
							socket.emit('update', {msg: 'created new room: '+roomDetails.roomName});  
							//publishing to all the clients new room is created
							io.of('/').adapter.clients(function(err, clients){
								clients.forEach(function(client){
									io.of('/').in(client).emit('newRoom', roomDetails);
								});
							});	
						} else {
							socket.emit('createRoomError', {errorMsg: 'Something bad happaend. Please try again.'});
						}
					});
				} else {
					io.of('/').to(socket).emit('reconnect', {from: 'createRoom'});
				}			
			});

			//event listener for request to join a room
			socket.on('joinRoom', function(roomDetails){
				//check if user session exists
				if(socket.handshake.session.user) {
					//create the room extension
					var roomExtension = roomDetails.ownerSocketId+'||'+roomDetails.roomName+'||'+roomDetails.ownerName;
					async.waterfall([
						//fetch all the rooms currently existing
						function(callback){
							io.of('/').adapter.allRooms(function(err, rooms){
								if(err) {
									err.message = 'Something bad happened. Please try again.';
									return callback(err, null);
								} else {
									return callback(null, rooms);
								}
							});		
						},
						//check for existence of room in redis adapter and fetch its password
						function(rooms, callback){
							if(rooms.indexOf(roomExtension) != -1) {
								redisClient.get(roomExtension, function(err, roomPassword){
									if(err) {
										err.message = 'Something bad happened. Please try again.';
										return callback(err, null);
									} else {
										return callback(null, roomPassword);
									}
								}); 	
							} else {
								return callback(new Error('Sorry!! This room does not exist anymore.'), null);
							}
						},
						//match the passwords
						function(roomPassword, callback){
							if(roomPassword !== roomDetails.password) {
								return callback(new Error('Password Mismatch!'), null);
							} else {
								return callback(null);	
							}
						},
						//make the socket leave all other rooms and join this one
						function(callback){
							utils.joinRoom(io, socket, roomDetails, function(status, errorMsg){
								if(status) {
									socket.emit('joinedRoom', roomDetails);
									return callback(null);
								} else {
									return callback(new Error(errorMsg), null);
								} 
							});
						},
						//update to all members of the room of this new joinee
						function(callback){
							io.of('/').adapter.clients([roomExtension], function (err, clients) {
								if(err) {
									return callback(new Error('Something bad happened. Please try again.'), null);
								} else {
									clients.forEach(function(client){
										io.of('/').to(client).emit('update', {msg: socket.handshake.session.user.name+' has joined the room.'});
									});
								}
							});
						}
					], function(err){
						if(err) {
							socket.emit('joinRoomError', {errorMsg: err.message});
						}
					});
				} else {
					io.of('/').to(socket).emit('reconnect', {from: 'joinRoom'});
				}
			});

			//event listener for the request to leave a room
			socket.on('leaveRoom', function(roomDetails){
				//check if user session exists
				if(socket.handshake.session.user) {
					//create the room extension
					var roomExtension = roomDetails.ownerSocketId+'||'+roomDetails.roomName+'||'+roomDetails.ownerName;
					async.series([
						//make the user leave the room
						function(callback){
							io.of('/').adapter.remoteLeave(socket.id, roomExtension, function(err){
								if(err) {
									err.message = 'Something bad happaend. Please try again.';
									return callback(err, null);							
								} else {
									socket.emit('leftRoom', {msg: 'Successfully Left room!!'});
									return callback(null);
								}
							});	
						},
						//notify the other players in the room about the exit of this user
						function(callback){
							io.of('/').adapter.clients([roomExtension], function(err, clients){
								if(!err){
									//if there are users in the room then notify them
									if(clients.length != 0) {
										clients.forEach(function(client){
											io.of('/').to(client).emit('update', {msg: socket.handshake.session.user.name+' has left the room.'});
										});
									//if there are no users in the room then ask all the users to update their room list
									} else {
										io.of('/').adapter.clients(function(err, clients){
											clients.forEach(function(client){
												io.of('/').to(client).emit('updateList', {});
											});
										});
									}
								}
								return callback(null);
							})
						}
					], function(err){
						if(err) {
							socket.emit('leaveRoomError', {errorMsg: err.message});
						}
					});
				} else {
					io.of('/').to(socket).emit('reconnect', {from: 'leaveRoom'});
				}
			});

			//event listener for the press of direction key by the user
			socket.on('keyPress',function(data) {
				//fetch the player from redis
				redisClient.hgetall(socket.id, function(err, player){
					if(!err && player) {
						if(data.inputId === 'left')
							player.pressingLeft = data.state;
						else if(data.inputId === 'right')
							player.pressingRight = data.state;
						else if(data.inputId === 'up')
							player.pressingUp = data.state;
						else if(data.inputId === 'down')
								player.pressingDown = data.state;
						redisClient.hmset(socket.id, player);
					}
				});
			});

			//event listener for the shoot key press by the user
			socket.on('shoot', function(data){
				//create the room extension
				var roomExtension = data.roomDetails.ownerSocketId+'||'+data.roomDetails.roomName+'||'+data.roomDetails.ownerName;
				//generate the bullet id
				var bulletId = roomExtension+'||'+socket.id;
				//get the player details to whom his bullet belongs
				redisClient.hgetall(socket.id, function(err, player){
					if(!err && player) {
						data.x -= player.x;
						data.y -= player.y;
						angle = Math.atan2(data.y,data.x);
						spdX = Math.ceil(CONSTANTS.bulletSpeed * Math.cos(angle));
						spdY = Math.ceil(CONSTANTS.bulletSpeed * Math.sin(angle));
						//crate the bullet
						var bullet = gameUtils.Bullet(bulletId, parseInt(player.x), parseInt(player.y), spdX, spdY);
						//save the bullet to the bullet-list of this lobby in redis client 
						redisClient.sadd(roomExtension+'||bullets', bulletId);
						//save the bullet details to redis client
						redisClient.hmset(bulletId, bullet);
					}	
				});
			});

			//event listener for the request to start a game
			socket.on('startGame', function(roomDetails){
				//check if user session exists
				if(socket.handshake.session.user) {
					if(roomDetails.ownerSocketId == undefined || roomDetails.ownerName == undefined) {
						socket.emit('startGameError', {errorMsg: 'Something went wrong!'});
					} else {
						//generate the extension with which the lobby is registered in socket connections
						var roomExtension = roomDetails.ownerSocketId+'||'+roomDetails.roomName+'||'+roomDetails.ownerName;
						async.waterfall([
							//get all the socket id connected to this room
							function(callback){
								io.of('/').adapter.clients([roomExtension], function(err, socketIds){
									if(err) {
										err.message = 'Somethign bad happened. Please try again.'
										return callback(err, null);
									} else {
										return callback(null, socketIds);
									}
								});	
							},
							//initialize players for these sockets in redis client
							function(socketIds, callback){
								for(var i=0;i<socketIds.length;i++) {
									var player = gameUtils.Player(socketIds[i], CONSTANTS.startPositions[i].x, CONSTANTS.startPositions[i].y);
									//delete garbage data from redis client
									redisClient.del(socketIds[i]);
									//save the player details inredis client with its socket id as key
									redisClient.hmset(socketIds[i], player);
								}
								//delete garbage data for lobby name in redis client
								redisClient.del(roomExtension+'||players');
								//add the players to the list of players in this lobby on redis client
								socketIds.forEach(function(socketId){
									redisClient.sadd(roomExtension+'||players', socketId);	
								});
								return callback(null, socketIds);
							},
							//fire game started event to these sockets
							function(socketIds, callback){
								//loop that shoots frames to all the connected sockets to this lobby
								var GameTimer = setInterval(function(){
									var frame = {};
									frame.players = [];
									frame.bullets = [];
									//search for sockets connected to this room
									io.of('/').adapter.clients([roomExtension], function(err, socketIds){
										async.parallel({
											//get players from redis and update their position
											players: function(innerCallback){
												//get the players from redis
												async.waterfall([
													function(nestedCallback){
														redisClient.smembers(roomExtension+'||players', function(err, playerIds){
															if(err) {
																err.message = 'Something bad Happened. Please Try Again';
																nestedCallback(err, null);
															} else {
																nestedCallback(null, playerIds);
															}
														});	
													},
													//update the player positions 
													function(playerIds, nestedCallback){
														async.each(playerIds, function(playerId, cb){
															redisClient.hgetall(playerId, function(err, player){
																if(err) {
																	err.message = 'Something bad Happened. Please Try Again';
																	cb(err, null);
																} else {
																	if(player != undefined && player != null) {
																		//update player postiion
																		gameUtils.updatePlayer(player);
																		//save updated player to redis client
																		redisClient.hmset(playerId, player);
																		//pus hthe player to frame 
																		frame.players.push(player);		
																	}
																	cb(null, null);
																}
															});
														}, function(err){
															if(err) {
																err.message = 'Something bad Happened. Please Try Again';
																nestedCallback(err);
															} else {
																nestedCallback(null);
															}
														});
													}
												], function(err){
													if(err) {
														err.message = 'Something bad Happened. Please Try Again';
														innerCallback(err, null);
													} else {
														innerCallback(null, null);
													}
												});
											},
											bullets: function(innerCallback){
												//get the bullets of this frame and update and save them
												async.waterfall([
													function(nestedCallback){
														//get all the bullets that exist in the frame
														redisClient.smembers(roomExtension+'||bullets', function(err, bulletIds){
															if(err) {
																err.message = 'Something bad Happened. Please Try Again';
																nestedCallback(err, null);
															} else {
																nestedCallback(null, bulletIds);
															}
														});	
													},
													//update the positions of all the bulllets
													function(bulletIds, nestedCallback){
														async.each(bulletIds, function(bulletId, cb){
															//get the bullet details from redis client
															redisClient.hgetall(bulletId, function(err, bullet){
																if(err) {
																	err.message = 'Something bad Happened. Please Try Again';
																	cb(err, null);
																} else {
																	if(bullet != undefined && bullet != null) {
																		//update and check if the bullet is within the field
																		var removeBullet = gameUtils.updateBullet(bullet);
																		//if bullet is outside the field boundary remove it else add it to frame
																		if(removeBullet) {
																			redisClient.srem(roomExtension+'||bullets', bulletId);	
																			redisClient.del(bulletId);
																		} else {
																			redisClient.hmset(bulletId, bullet);
																			frame.bullets.push(bullet);
																		}
																	}
																	cb(null, null);
																}
															});
														}, function(err){
															if(err) {
																err.message = 'Something bad Happened. Please Try Again';
																nestedCallback(err);
															} else {
																nestedCallback(null);
															}
														});
													}
												], function(err){
													if(err) {
														err.message = 'Something bad Happened. Please Try Again';
														innerCallback(err, null);
													} else {
														innerCallback(null, null);
													}
												});
											},
											//add the barriers to the frame
											barriers: function(innerCallback){
												frame.barriers = CONSTANTS.barrierPositions;
												return innerCallback(null, null);
											}
										}, function(err, results){
											//check for collision of the bullets with the players and barriers
											frame.bullets.forEach(function(bullet){
												//check for collision with each player
												frame.players.forEach(function(player){
													//if distance between the player and the bullet is less than or equal to collision-distance
													//if collision has occurred bullet and player are removed from frame
													if(gameUtils.getDistance(bullet, player)<=CONSTANTS.collisionDistance &&
														//check if the bullet belongs to the player itself
														bullet.id.split('||')[3] != player.id){
														//remove bullet from current frame
														frame.bullets.splice(frame.bullets.indexOf(bullet), 1);
														//remove bullet from bullets collection in redis
														redisClient.srem(roomExtension+'||bullets', bullet.id);
														//remove bullet from redis memory
														redisClient.del(bullet.id);
														//remove player from current frame
														frame.players.splice(frame.players.indexOf(player), 1);
														//remove player from players collection in redis
														redisClient.srem(roomExtension+'||players', player.id);
														//remove player from redis memory
														redisClient.del(player.id);
														//notify the player that he has been killed
														io.of('/').to(player.id).emit('gameOver', {});
													}
												});
												frame.barriers.forEach(function(barrier){
													//if distance between the barrier and the bullet is less than or equal to collision-distance
													//if collision has occurred bullet is removed from frame
													if(gameUtils.getDistance(bullet, barrier)<=CONSTANTS.collisionDistance){
														//remove bullet from current frame
														frame.bullets.splice(frame.bullets.indexOf(bullet), 1);
														//remove bullet from bullets collection in redis
														redisClient.srem(roomExtension+'||bullets', bullet.id);
														//remove bullet from redis memory
														redisClient.del(bullet.id);
													}
												});
											});
											//if there is only one player in the room notify him that he has won the game 
											if(frame.players.length==1) {
												io.of('/').to(frame.players[0].id).emit('youWon', {});
												socketIds.forEach(function(socketId){
													io.of('/').to(socketId).emit('newFrame', frame);
												});
												//stop the frame emitting loop if there is only one player left
												clearInterval(GameTimer);
											} else {
												//emit the frame to all the players in the room
												socketIds.forEach(function(socketId){
													io.of('/').to(socketId).emit('newFrame', frame);
												});
											}
										});
									});
								}, 1000/CONSTANTS.fps);
								return callback(null, socketIds);
							},
							//indicate to all the members that the game has started
							function(socketIds, callback){
								socketIds.forEach(function(socketId){
									io.of('/').to(socketId).emit('gameStarted', {});
								});	
								return callback(null);
							},
						], function(err, result){
							if(err) {
								socket.emit('startGameError', {errorMsg: err.msg});
							}
							//socket.emit('timerId', {});
						});
					}
				} else {
					io.of('/').to(socket.id).emit('reconnect', {from: 'startGame'});
				}
			});

			socket.on('disconnect', function(){

			});

		}); 
	});

	return server;
	
}).listen(CONSTANTS.port, function() {
	console.log('server started on port: '+ CONSTANTS.port);
});
	 
// server.listen(process.env.PORT || CONSTANTS.port,function(){
// 	console.log('server listening at port '+ (process.env.PORT || CONSTANTS.port));
// });

