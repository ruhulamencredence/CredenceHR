const net=require('net'),fs=require('fs');const out=process.argv[2];
net.createServer(s=>{let data=false,buf='',mail='';s.write('220 sink\r\n');
 s.on('data',d=>{buf+=d.toString();let i;while((i=buf.indexOf('\r\n'))>=0){const l=buf.slice(0,i);buf=buf.slice(i+2);
  if(data){ if(l==='.'){data=false;fs.appendFileSync(out,mail+'\n=====\n');mail='';s.write('250 ok\r\n');} else mail+=l+'\n'; continue;}
  const u=l.toUpperCase();
  if(u.startsWith('EHLO')) s.write('250-sink\r\n250 AUTH PLAIN LOGIN\r\n');
  else if(u.startsWith('AUTH PLAIN')) s.write('235 ok\r\n');
  else if(u.startsWith('AUTH LOGIN')) {s.write('334 VXNlcm5hbWU6\r\n');s.once('data',()=>{s.write('334 UGFzc3dvcmQ6\r\n');s.once('data',()=>s.write('235 ok\r\n'));});}
  else if(u==='DATA'){data=true;s.write('354 go\r\n');}
  else if(u==='QUIT'){s.write('221 bye\r\n');s.end();}
  else s.write('250 ok\r\n');}});}).listen(2525,'127.0.0.1');
