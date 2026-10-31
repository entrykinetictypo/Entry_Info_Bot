// One-time public, unauthenticated network diagnostics; no secrets or cookies.
const nickname = "삼류";
async function send(name,url,body=null,method="POST") {
  try {
    const opts={method,signal:AbortSignal.timeout(10000),headers:{
      "User-Agent":"EntryInfoBot-Diagnostic/0.1",
      "Accept":"application/json",
      "Content-Type":"application/json",
      "Origin":"https://playentry.org",
      "Referer":"https://playentry.org/community/entrystory/list"
    }};
    if(body!==null)opts.body=JSON.stringify(body);
    const response=await fetch(url,opts);
    const payload=method==="HEAD"?"(HEAD request)":(await response.text()).slice(0,700);
    console.log("==="+name+"===",JSON.stringify({
      status:response.status,type:response.headers.get("content-type"),
      cors:response.headers.get("access-control-allow-origin"),
      body:payload
    }));
  }catch(e){console.log("==="+name+"=== ERROR",e.message);}
}
const standard="query($nickname:String){user(nickname:$nickname){id nickname}}";
const named="query SELECT_USER_BY_NICKNAME($nickname:String!){user(nickname:$nickname){id nickname}}";
const list="query SELECT_USER_LIST($query:String,$pageParam:PageParam){userList(query:$query,pageParam:$pageParam){total list{id nickname}}}";
await send("raw DB HEAD","https://raw.githubusercontent.com/entrykinetictypo/ent2-backup/main/data.json",null,"HEAD");
await send("github DB api HEAD","https://api.github.com/repos/entrykinetictypo/ent2-backup/contents/data.json?ref=main",null,"HEAD");
await send("generic user with String","https://playentry.org/graphql",{query:standard,variables:{nickname}});
await send("generic named user","https://playentry.org/graphql",{query:named,variables:{nickname}});
await send("named user endpoint","https://playentry.org/graphql/SELECT_USER_BY_NICKNAME",{query:named,variables:{nickname}});
await send("generic userList","https://playentry.org/graphql",{query:list,variables:{query:nickname,pageParam:{display:8,sort:"created"}}});
await send("named userList endpoint","https://playentry.org/graphql/SELECT_USER_LIST",{query:list,variables:{query:nickname,pageParam:{display:8,sort:"created"}}});
await send("space getUsers","https://space.playentry.org/graphql/getUsers",{
 query:"query getUsers($param:UserSearch!){getUsers(param:$param){total list{id nickname}}}",
 variables:{param:{nickname,display:4}},operationName:"getUsers"
});
