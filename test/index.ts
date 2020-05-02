import chai, { expect, Assertion } from "chai";
import chaiHttp from "chai-http";

import express, { Handler } from "express";
import bodyParser from "body-parser";

import * as t from "io-ts";

import { createRpcHandler, DomainError } from "../src/rpc";

const ENDPOINT = "/rpc";

declare global {
  export namespace Chai {
    interface TypeComparison {
      rpcError(code: number, message?: string): void;
      rpcResult(result: any): void;
    }
  }
}

console.error = () => {};
console.warn = () => {};
console.log = () => {};

Assertion.addMethod("rpcError", function (code: number, message?: string) {
  new Assertion(this._obj).to.have.property("jsonrpc", "2.0");
  new Assertion(this._obj).to.have.property("id");
  new Assertion(this._obj).to.have.property("error");
  new Assertion(this._obj.error).to.have.property("message");
  new Assertion(this._obj.error.message).to.be.a("string");
  new Assertion(this._obj.error).to.have.property("code", code);

  if (message != null) {
    new Assertion(this._obj.error).to.have.property("message", message);
  }
});

Assertion.addMethod("rpcResult", function (result: any) {
  new Assertion(this._obj).to.have.property("jsonrpc", "2.0");
  new Assertion(this._obj).to.have.property("id");
  new Assertion(this._obj).to.have.property("result").to.deep.equal(result);
});

chai.use(chaiHttp);

function getApp(middleware: Handler) {
  const app = express();
  app.use(ENDPOINT, bodyParser.json(), middleware);
  return app;
}

it("should test the custom assertions", () => {
  const error = {
    jsonrpc: "2.0",
    id: 0,
    error: { code: 123, message: "some message" },
  };

  const result = {
    jsonrpc: "2.0",
    id: 0,
    result: { arr: [1, 2, 3] },
  };

  expect(error).to.be.an.rpcError(123);
  expect(result).to.be.an.rpcResult({ arr: [1, 2, 3] });
});

it("should pass a smoke test", (done) => {
  const rpc = createRpcHandler<{
    v: string;
  }>();

  rpc.method(
    {
      name: "test-method",
      returns: t.string,
      params: t.type({
        a: t.number,
        b: t.string,
      }),
    },
    async function (params, context) {
      const sum = params.a + parseInt(params.b, 10);
      const cat = params.a + params.b;
      return `${sum} ${cat} ${context.v}`;
    }
  );

  const app = getApp(
    rpc.middleware((req) => {
      return {
        v: req.headers["x-test-header"] as string,
      };
    })
  );

  chai
    .request(app)
    .post("/rpc")
    .set("x-test-header", "abc")
    .send({
      jsonrpc: "2.0",
      method: "test-method",
      params: { a: 10, b: "20" },
      id: 0,
    })
    .end((err, res) => {
      expect(err).to.be.null;
      expect(res).to.have.status(200);
      expect(res.body.result).to.eq("30 1020 abc");
      done();
    });
});

it("should return an error if the params type isn't correct", (done) => {
  const rpc = createRpcHandler();

  rpc.method(
    {
      name: "test-method",
      returns: t.null,
      params: t.type({
        firstParam: t.number,
        secondParam: t.string,
      }),
    },
    async function () {
      return null;
    }
  );

  const app = getApp(rpc.middleware());

  chai
    .request(app)
    .post("/rpc")
    .set("x-test-header", "abc")
    .send({
      jsonrpc: "2.0",
      method: "test-method",
      params: { firstParam: 10, secondParam: 20 },
      id: 0,
    })
    .end((err, res) => {
      expect(err).to.be.null;
      expect(res).to.have.status(200);
      expect(res.body).to.be.rpcError(-31999);

      // This could change if error reporting is changed to work differently
      const { data } = res.body.error;
      expect(data.errors[0]).to.contain("number");
      expect(data.errors[0]).to.contain("string");
      expect(data.errors[0]).to.not.contain("/firstParam");
      expect(data.errors[0]).to.contain("/secondParam");
      done();
    });
});

it("should return an error if the return type isn't correct", (done) => {
  const rpc = createRpcHandler();

  rpc.method(
    {
      name: "test-method",
      returns: t.number,
      params: t.type({}),
    },
    async function () {
      return ("a string" as unknown) as number;
    }
  );

  const app = getApp(rpc.middleware());

  chai
    .request(app)
    .post(ENDPOINT)
    .send({
      jsonrpc: "2.0",
      method: "test-method",
      params: {},
      id: 0,
    })
    .end((err, res) => {
      expect(err).to.be.null;
      expect(res).to.have.status(200);
      expect(res.body).to.be.an.rpcError(-31998);
      done();
    });
});

it("should fail with HTTP 500 when context builder fails", (done) => {
  const rpc = createRpcHandler();

  rpc.method(
    {
      name: "test-method",
      returns: t.number,
      params: t.type({}),
    },
    async function () {
      return 0;
    }
  );

  const app = getApp(
    rpc.middleware(() => {
      throw new Error("context builder failed");
    })
  );

  chai
    .request(app)
    .post(ENDPOINT)
    .send({
      jsonrpc: "2.0",
      method: "test-method",
      params: {},
      id: 0,
    })
    .end((err, res) => {
      expect(res).to.have.status(500);
      expect(err).to.be.null;
      done();
    });
});

it("should handle batches with some failures", (done) => {
  const rpc = createRpcHandler();

  rpc.method(
    {
      name: "test-method-1",
      returns: t.number,
      params: t.type({}),
    },
    async function () {
      return 0;
    }
  );

  rpc.method(
    {
      name: "test-method-2",
      returns: t.number,
      params: t.type({ mandatory: t.number }),
    },
    async function () {
      return 0;
    }
  );

  const app = getApp(rpc.middleware());

  chai
    .request(app)
    .post(ENDPOINT)
    .send([
      {
        jsonrpc: "2.0",
        method: "test-method-1",
        params: {},
        id: 0,
      },
      {
        jsonrpc: "2.0",
        method: "test-method-2",
        params: {},
        id: 1,
      },
    ])
    .end((err, res) => {
      expect(err).to.be.null;
      expect(res).to.have.status(200);

      const batchResponse = res.body;
      const shouldSucceed = batchResponse.find((r0: any) => r0.id === 0);
      const shouldFail = batchResponse.find((r1: any) => r1.id === 1);

      expect(shouldSucceed).to.have.property("result");
      expect(shouldFail).to.be.an.rpcError(-31999);

      done();
    });
});

it("should return a general domain error", (done) => {
  const rpc = createRpcHandler();

  rpc.method(
    {
      name: "test-method",
      returns: t.void,
      params: t.type({}),
    },
    async function () {
      throw new Error();
    }
  );

  const app = getApp(rpc.middleware());

  chai
    .request(app)
    .post(ENDPOINT)
    .send({
      jsonrpc: "2.0",
      method: "test-method",
      params: {},
      id: 0,
    })
    .end((err, res) => {
      expect(err).to.be.null;
      expect(res).to.have.status(200);
      expect(res.body).to.be.an.rpcError(-31997);
      done();
    });
});

it("should return a specific domain error", (done) => {
  const rpc = createRpcHandler();

  rpc.method(
    {
      name: "test-method",
      returns: t.void,
      params: t.type({}),
    },
    async function () {
      throw new DomainError("custom error message", 12345);
    }
  );

  const app = getApp(rpc.middleware());

  chai
    .request(app)
    .post(ENDPOINT)
    .send({
      jsonrpc: "2.0",
      method: "test-method",
      params: {},
      id: 0,
    })
    .end((err, res) => {
      expect(err).to.be.null;
      expect(res).to.have.status(200);
      expect(res.body).to.be.an.rpcError(12345, "custom error message");
      done();
    });
});
